/* The household's source filters, and the address they build. The UI never shows the source's name: it is just "Sources". ES5 (runs on webOS 4). */
var Sources = (function () {
  var BASE = 'https://torrentio.strem.fun';
  var QUALITIES = ['4K', '1080p', '720p'];
  var SIZES = [0, 4, 8, 15, 30];                                 // largest file, in GB (0 = no limit)
  var HIDE = [                                                    // [key, label, hint, filter words]
    ['dv', 'Dolby Vision', 'Often will not play on older TVs', ['dolbyvision', 'dolbyvisionwithhdr']],
    ['hdr', 'HDR', 'Washed-out colours on screens without HDR', ['hdrall']],
    ['remux', 'BluRay remux', 'Very large files', ['brremux']],
    ['threed', '3D', 'Side-by-side pictures', ['threed']],
    ['unknown', 'Unknown quality', 'Files whose quality is not stated', ['unknown']]
  ];
  var LANGS = [['', 'Any'], ['english', 'English'], ['afrikaans', 'Afrikaans'], ['french', 'French'], ['german', 'German'], ['spanish', 'Spanish'], ['portuguese', 'Portuguese'], ['italian', 'Italian'],
    ['dutch', 'Dutch'], ['russian', 'Russian'], ['hindi', 'Hindi'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['chinese', 'Chinese'], ['arabic', 'Arabic']];
  var PROVIDERS = [['yts', 'YTS'], ['eztv', 'EZTV'], ['rarbg', 'RARBG'], ['1337x', '1337x'], ['thepiratebay', 'The Pirate Bay'], ['kickasstorrents', 'KickassTorrents'], ['torrentgalaxy', 'TorrentGalaxy'],
    ['magnetdl', 'MagnetDL'], ['horriblesubs', 'HorribleSubs'], ['nyaasi', 'Nyaa'], ['tokyotosho', 'TokyoTosho'], ['anidex', 'AniDex'], ['rutor', 'Rutor'], ['rutracker', 'RuTracker'],
    ['comando', 'Comando'], ['bludv', 'BluDV'], ['torrent9', 'Torrent9'], ['ilcorsaronero', 'ilCorSaRoNeRo'], ['mejortorrent', 'MejorTorrent'], ['wolfmax4k', 'Wolfmax4K'], ['cinecalidad', 'Cinecalidad'], ['besttorrents', 'BestTorrents']];

  function defaults() { return { hide: { dv: false, hdr: false, remux: false, threed: false, unknown: false }, maxGb: 0, language: '', providers: [], custom: '' }; }
  function normalize(c) {
    var d = defaults(); c = c || {};
    HIDE.forEach(function (h) { d.hide[h[0]] = !!(c.hide && c.hide[h[0]] === true); });
    d.maxGb = SIZES.indexOf(c.maxGb) >= 0 ? c.maxGb : 0;
    d.language = typeof c.language === 'string' ? c.language : '';
    d.providers = (c.providers || []).filter(function (p) { return PROVIDERS.some(function (x) { return x[0] === p; }); });
    d.custom = typeof c.custom === 'string' ? c.custom : '';
    return d;
  }
  /* the address that answers for this set of filters. Camera recordings and screeners are always left out. */
  function url(cfg) {
    var c = normalize(cfg);
    if (/^https:\/\//.test(c.custom)) return c.custom.replace(/\/manifest\.json.*$/, '').replace(/\/+$/, '');
    var parts = [], q = ['scr', 'cam'];
    if (c.providers.length) parts.push('providers=' + c.providers.join(','));
    if (c.language) parts.push('language=' + c.language);
    HIDE.forEach(function (h) { if (c.hide[h[0]]) q = q.concat(h[3]); });
    parts.push('qualityfilter=' + q.join(','));
    if (c.maxGb) parts.push('sizefilter=' + c.maxGb + 'GB');
    return BASE + '/' + parts.join('|');
  }
  function langName(code) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === code) return LANGS[i][1]; return 'Any'; }
  function summary(cfg) {
    var c = normalize(cfg), out = [];
    var hid = HIDE.filter(function (h) { return c.hide[h[0]]; }).map(function (h) { return h[1]; });
    if (hid.length) out.push('Hiding ' + hid.join(', '));
    if (c.maxGb) out.push('Files up to ' + c.maxGb + ' GB');
    if (c.language) out.push(langName(c.language) + ' first');
    if (c.providers.length) out.push(c.providers.length + ' sites');
    if (c.custom) out.push('Custom address');
    return out.length ? out.join(' · ') : 'Everything except camera recordings';
  }
  return { QUALITIES: QUALITIES, SIZES: SIZES, HIDE: HIDE, LANGS: LANGS, PROVIDERS: PROVIDERS, defaults: defaults, normalize: normalize, url: url, summary: summary, langName: langName };
})();
if (typeof module !== 'undefined') module.exports = Sources;
