/* TMDB through the JoolzTV server (the key never leaves the server). Everything here quietly does nothing when the server has no key. ES5. */
var Tmdb = (function () {
  var on = false, canKey = false, limit = null, mem = {}, known = false;
  var COUNTRIES = [['ZA', 'South Africa'], ['GB', 'United Kingdom'], ['US', 'United States'], ['AU', 'Australia'], ['CA', 'Canada'], ['IE', 'Ireland'], ['NZ', 'New Zealand'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['ES', 'Spain'], ['IT', 'Italy'], ['PT', 'Portugal']];
  var LOCALES = [['en-GB', 'English (UK)'], ['en-US', 'English (US)'], ['en-ZA', 'English (South Africa)'], ['af-ZA', 'Afrikaans'], ['fr-FR', 'French'], ['de-DE', 'German'], ['es-ES', 'Spanish'], ['pt-PT', 'Portuguese'], ['nl-NL', 'Dutch'], ['it-IT', 'Italian']];
  function prefs() { return Api.prefs(); }
  /* country and language: the household's choice, else what the device says, else the time zone */
  function region() {
    var p = prefs().region; if (p) return p;
    var m = /-([A-Za-z]{2})$/.exec(navigator.language || ''); if (m) return m[1].toUpperCase();
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    return /Johannesburg/.test(tz) ? 'ZA' : /London/.test(tz) ? 'GB' : 'US';
  }
  function locale() {
    var p = prefs().locale; if (p) return p;
    var l = navigator.language || ''; if (/^[a-z]{2}-[A-Za-z]{2}$/.test(l)) return l.slice(0, 2).toLowerCase() + '-' + l.slice(3).toUpperCase();
    return /^[a-z]{2}$/.test(l) ? l : 'en-GB';
  }
  function qs(o) { var a = []; for (var k in o) if (o[k] !== undefined && o[k] !== null && o[k] !== '') a.push(k + '=' + encodeURIComponent(o[k])); return a.join('&'); }
  function get(path, o, ttl) {
    var url = path + '?' + qs(Object.assign({ locale: locale(), region: region() }, o || {})), hit = mem[url];
    if (hit && Date.now() - hit.at < (ttl || 120000)) return hit.p;
    var p = Backend.call('GET', url, undefined, undefined, 25000);
    mem[url] = { at: Date.now(), p: p }; p.catch(function () { delete mem[url]; });
    return p;
  }
  function init() {
    return Backend.call('GET', '/api/tmdb/status', undefined, undefined, 8000).then(function (j) { on = !!j.enabled; canKey = !!j.canSetKey; limit = j.limit == null ? null : j.limit; known = true; }).catch(function (e) { on = false; if (e && e.status !== 401) known = true; }).then(function () { return Policy.init(); });
  }
  return {
    init: init, known: function () { return known; }, forget: function () { known = false; }, on: function () { return on; }, canKey: function () { return canKey; }, limit: function () { return limit; }, restricted: function () { return limit !== null; },
    region: region, locale: locale, COUNTRIES: COUNTRIES, LOCALES: LOCALES,
    title: function (type, imdb) { return get('/api/tmdb/title', { type: type, imdb: imdb }, 600000); },
    season: function (tmdb, n) { return get('/api/tmdb/season', { tmdb: tmdb, season: n }, 600000); },
    list: function (kind, type) { return get('/api/tmdb/list', { kind: kind, type: type }, 600000); },
    genres: function (type) { return get('/api/tmdb/genres', { type: type }, 3600000); },
    discover: function (o) { return get('/api/tmdb/discover', o, 300000); },
    person: function (id) { return get('/api/tmdb/person', { id: id }, 600000); },
    collections: function (q) { return get('/api/tmdb/collections', q ? { q: q } : {}, q ? 300000 : 3600000); },
    collection: function (id) { return get('/api/tmdb/collection', { id: id }, 600000); },
    search: function (q) { return get('/api/tmdb/search', { q: q }, 300000); },
    resolve: function (tmdb, type) { return get('/api/tmdb/resolve', { tmdb: tmdb, type: type }, 3600000); },
    setKey: function (key) { return Backend.call('PUT', '/api/tmdb/key', { key: key }).then(function (j) { on = !!j.enabled; mem = {}; return j; }); },
    /* before a title starts: allowed for this profile? */
    playCheck: function (imdb, type) {
      if (!on || limit === null) return Promise.resolve({ ok: true });
      return Backend.call('POST', '/api/play-check', { imdb: imdb, type: type, region: region() }).catch(function () { return { ok: false, message: 'This title could not be age-checked right now.' }; });
    }
  };
})();
