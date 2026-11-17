/* Watch progress and My List of the active profile, merged with the server (newest entry wins). */
var Sync = (function () {
  var timer = null, busy = false, status = '', started = false;
  function mergeMaps(a, b) {
    var out = {}, k; for (k in a) out[k] = a[k];
    for (k in b) if (!out[k] || (b[k].ts || 0) > (out[k].ts || 0)) out[k] = b[k];
    return out;
  }
  function run(cb) {
    if (!Backend.token() || busy) return cb && cb(false);
    busy = true;
    var pid = Store.active();
    Backend.sync({ resume: Store.get('resume', {}), list: Store.get('list', {}) }).then(function (j) {
      if (Store.active() === pid) {
        Store.setFor(pid, 'resume', mergeMaps(Store.getFor(pid, 'resume', {}), j.state.resume), true);
        Store.setFor(pid, 'list', mergeMaps(Store.getFor(pid, 'list', {}), j.state.list), true);
      }
      status = 'Synced ' + new Date().toLocaleTimeString(); if (cb) cb(true);
    }).catch(function (e) { status = 'Sync failed: ' + e.message; if (e.status === 401 && window.Views && Views.signedOut) Views.signedOut(); if (cb) cb(false); })
      .then(function () { busy = false; });
  }
  function dirty() { if (busy || !Backend.token()) return; clearTimeout(timer); timer = setTimeout(run, 2500); }
  function start() {
    if (started) return; started = true;
    Store.onChange(dirty);
    setInterval(function () { run(); }, 60000);
  }
  return { start: start, run: run, status: function () { return status; } };
})();
