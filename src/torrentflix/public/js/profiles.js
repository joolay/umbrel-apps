/* Up to 12 local profiles, each with its own watchlist, progress and (optional) Stremio account. */
var Profiles = (function () {
  var MAX = 12;
  var COLORS = ['#e50914', '#0071eb', '#46d369', '#f5a623', '#9b59b6', '#16a085', '#e84393', '#00b3b3', '#e67e22', '#7f8c8d', '#c0392b', '#2c82c9'];
  function map() { return Store.get('profiles', {}); }
  function all() {
    var m = map();
    return Object.keys(m).map(function (k) { return m[k]; }).filter(function (p) { return !p.deleted; })
      .sort(function (a, b) { return (a.created || 0) - (b.created || 0) || String(a.id).localeCompare(String(b.id)); });
  }
  function get(id) { var m = map(); return m[id] && !m[id].deleted ? m[id] : null; }
  function add(name, color) {
    if (all().length >= MAX) return null;
    var m = map(), id = Math.random().toString(36).slice(2, 8), now = Date.now();
    m[id] = { id: id, name: (name || 'Profile').trim().slice(0, 16) || 'Profile', color: color || COLORS[all().length % COLORS.length], created: now, ts: now };
    Store.set('profiles', m); return m[id];
  }
  function update(id, name, color) {
    var m = map(); if (!m[id]) return;
    m[id].name = (name || m[id].name).trim().slice(0, 16) || m[id].name; m[id].color = color || m[id].color; m[id].ts = Date.now(); delete m[id].auto;
    Store.set('profiles', m);
  }
  function remove(id) {
    var m = map(); if (!m[id] || all().length < 2) return false;
    m[id].deleted = true; m[id].ts = Date.now(); Store.set('profiles', m);
    Store.purgeProfile(id); if (Store.active() === id) Store.setActive(null);
    return true;
  }
  function active() { var id = Store.active(); return id ? get(id) : null; }
  function setActive(id) { Store.setActive(id); }
  /* first run: create a profile; bring over any pre-profile data (resume, account) */
  function ensure() {
    if (all().length) return;
    var p = add('Profile 1', COLORS[0]);
    var m0 = map(); m0[p.id].auto = true; Store.set('profiles', m0);   // auto-created default: dropped if real profiles arrive via sync
    try {
      ['resume', 'auth', 'email', 'sync'].forEach(function (k) {
        var v = localStorage.getItem('flix.' + k);
        if (v != null) { localStorage.setItem('flix.p' + p.id + '.' + k, v); localStorage.removeItem('flix.' + k); }
      });
    } catch (e) {}
  }
  return { all: all, get: get, add: add, update: update, remove: remove, active: active, setActive: setActive, ensure: ensure, COLORS: COLORS, MAX: MAX };
})();
