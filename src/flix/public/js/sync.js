/* Optional profile sync with JoolzFlix on Umbrel: merges profiles, watch progress and watchlists (per-entry, newest wins). */
var Sync = (function () {
  var timer = null, busy = false, status = 'Not connected', started = false;
  function base() {
    if (window.TF_BACKEND) return window.TF_BACKEND;
    var u = Store.get('syncurl', '');
    return u ? u.replace(/\/+$/, '') + '/tf/api' : null;
  }
  function mergeMaps(a, b) {
    var out = {}, k;
    for (k in a) out[k] = a[k];
    for (k in b) if (!out[k] || (b[k].ts || 0) > (out[k].ts || 0)) out[k] = b[k];
    return out;
  }
  function localState() {
    var st = { profiles: Store.get('profiles', {}) };
    Object.keys(st.profiles).forEach(function (id) {
      if (st.profiles[id].deleted) return;
      st['p' + id + '.resume'] = Store.getFor(id, 'resume', {});
      st['p' + id + '.list'] = Store.getFor(id, 'list', {});
    });
    return st;
  }
  function apply(remote) {
    if (!remote || typeof remote !== 'object') return;
    var profiles = mergeMaps(Store.get('profiles', {}), remote.profiles || {});
    Store.set('profiles', profiles);                        // listeners ignore changes while a sync is running
    Object.keys(remote).forEach(function (key) {
      var m = /^p([a-z0-9]+)\.(resume|list)$/.exec(key); if (!m) return;
      var p = profiles[m[1]]; if (!p || p.deleted) return;
      Store.setFor(m[1], m[2], mergeMaps(Store.getFor(m[1], m[2], {}), remote[key]), true);
    });
    // an unused auto-created "Profile 1" is dropped when real profiles exist (or when several devices each created one)
    var live = Object.keys(profiles).map(function (id) { return profiles[id]; }).filter(function (p) { return !p.deleted; });
    var autos = live.filter(function (p) { return p.auto && !Object.keys(Store.getFor(p.id, 'resume', {})).length && !Object.keys(Store.getFor(p.id, 'list', {})).length; });
    var kill = autos.length < live.length ? autos : autos.sort(function (a, b) { return (a.created || 0) - (b.created || 0); }).slice(1);
    if (kill.length) { kill.forEach(function (p) { p.deleted = true; p.ts = Date.now(); }); Store.set('profiles', profiles); }
    // drop data of profiles deleted elsewhere
    Object.keys(profiles).forEach(function (id) { if (profiles[id].deleted && Store.getFor(id, 'resume', null) !== null) Store.purgeProfile(id); });
    if (Store.active() && !Profiles.get(Store.active())) { Store.setActive(null); if (window.Views && Views.profiles) Views.profiles(false); }
  }
  function run(cb) {
    var b = base(); if (!b) { status = 'Not connected'; return cb && cb(false); }
    if (busy) return cb && cb(false);
    busy = true;
    fetch(b + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: localState() }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { apply(j.state); status = 'Synced ' + new Date().toLocaleTimeString(); if (cb) cb(true); })
      .catch(function (e) { status = 'Sync failed: ' + e.message; if (cb) cb(false); })
      .then(function () { busy = false; });
  }
  function dirty() { if (busy || !base()) return; clearTimeout(timer); timer = setTimeout(run, 2500); }
  function start() {
    if (started) return; started = true;
    Store.onChange(dirty);
    setInterval(function () { run(); }, 60000);
    run();
  }
  return { start: start, run: run, status: function () { return status; }, enabled: function () { return !!base(); }, webMode: function () { return !!window.TF_BACKEND; } };
})();
