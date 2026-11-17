/* What this profile may watch: the kid rules from the parents (allow-list / block-list / age limit), and the global adult block that applies to everyone. ES5. */
var Policy = (function () {
  var st = { kid: false, mode: 'off', limit: null, allowed: [] }, set = {};
  function init() {
    return Backend.call('GET', '/api/policy', undefined, undefined, 8000).then(function (j) { st = j; set = {}; (j.allowed || []).forEach(function (a) { set[a.imdb] = 1; }); }).catch(function (e) { if (e && e.status === 401) return; st = { kid: false, mode: 'off', limit: null, allowed: [] }; set = {}; });
  }
  /* adult material is recognisable in the data the app already has: Cinemeta's genre, or an obvious name */
  function adultMeta(m) {
    if (!m) return false;
    var g = m.genres || [], i;
    for (i = 0; i < g.length; i++) if (/^adult$/i.test(String(g[i]))) return true;
    return /\b(xxx|porn|pornstar|hentai)\b/i.test(String(m.name || ''));
  }
  function cleanMetas(list) { return (list || []).filter(function (m) { return !adultMeta(m); }); }
  return {
    init: init, mode: function () { return st.mode; }, kid: function () { return st.kid; }, limit: function () { return st.limit; }, allowed: function () { return st.allowed; },
    onlyAllowed: function () { return st.mode === 'allow'; }, isAllowed: function (id) { return !!set[id]; },
    adultMeta: adultMeta, cleanMetas: cleanMetas,
    /* the server's decision for one title: {ok, reason, message} */
    check: function (imdb, type) {
      return Backend.call('POST', '/api/title-check', { imdb: imdb, type: type === 'series' ? 'series' : 'movie', region: Tmdb.region() }).catch(function () {
        return st.kid ? { ok: false, reason: 'offline', message: 'This title could not be checked right now.' } : { ok: true };
      });
    }
  };
})();
