/* localStorage wrapper (never throws). Profile-specific keys are namespaced per profile: flix.p<id>.<key>.
   resume / list are maps {id: entry-with-ts} that sync with the server (newest wins). */
var Store = (function () {
  var PROFILE = { resume: 1, list: 1, token: 1, email: 1, remember: 1, subs: 1 };
  var SYNC = { resume: 1, list: 1 };
  var listeners = [];

  function active() { try { return localStorage.getItem('flix.active'); } catch (e) { return null; } }
  function fullKey(k, pid) { var p = pid === undefined ? active() : pid; return 'flix.' + (PROFILE[k] && p ? 'p' + p + '.' : '') + k; }
  function read(fk, d) { try { var v = localStorage.getItem(fk); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function write(fk, v) { try { localStorage.setItem(fk, JSON.stringify(v)); } catch (e) {} }
  function changed(k) { if (SYNC[k]) listeners.forEach(function (f) { try { f(k); } catch (e) {} }); }

  return {
    get: function (k, d) { return read(fullKey(k), d); },
    set: function (k, v) { write(fullKey(k), v); changed(k); },
    del: function (k) { try { localStorage.removeItem(fullKey(k)); } catch (e) {} changed(k); },
    getFor: function (pid, k, d) { return read(fullKey(k, pid), d); },
    setFor: function (pid, k, v, silent) { write(fullKey(k, pid), v); if (!silent) changed(k); },
    delFor: function (pid, k) { try { localStorage.removeItem(fullKey(k, pid)); } catch (e) {} },
    setActive: function (pid) { try { if (pid) localStorage.setItem('flix.active', pid); else localStorage.removeItem('flix.active'); } catch (e) {} },
    active: active,
    purgeProfile: function (pid) {
      try {
        var del = [], pre = 'flix.p' + pid + '.';
        for (var i = 0; i < localStorage.length; i++) { var n = localStorage.key(i); if (n.indexOf(pre) === 0) del.push(n); }
        del.forEach(function (n) { localStorage.removeItem(n); });
      } catch (e) {}
    },
    onChange: function (f) { listeners.push(f); }
  };
})();
