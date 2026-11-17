/* Minimal polyfills for Chromium 53 (webOS 4.0). */
(function () {
  var d = Object.defineProperty;
  function def(o, n, f) { if (!o[n]) d(o, n, { value: f, writable: true, configurable: true }); }
  def(Object, 'values', function (o) { return Object.keys(o).map(function (k) { return o[k]; }); });
  def(Object, 'entries', function (o) { return Object.keys(o).map(function (k) { return [k, o[k]]; }); });
  def(String.prototype, 'padStart', function (n, s) { var t = String(this); s = s === undefined ? ' ' : String(s); if (t.length >= n || !s) return t; var p = ''; while (p.length < n - t.length) p += s; return p.slice(0, n - t.length) + t; });
  def(String.prototype, 'padEnd', function (n, s) { var t = String(this); s = s === undefined ? ' ' : String(s); if (t.length >= n || !s) return t; var p = ''; while (p.length < n - t.length) p += s; return t + p.slice(0, n - t.length); });
  def(Array.prototype, 'flat', function (dep) { dep = dep === undefined ? 1 : dep; var f = function (a, n) { return a.reduce(function (r, x) { return r.concat(Array.isArray(x) && n > 0 ? f(x, n - 1) : [x]); }, []); }; return f(this, dep); });
  def(Array.prototype, 'flatMap', function (fn, t) { return this.map(fn, t).flat(1); });
  def(Element.prototype, 'closest', function (s) { var e = this; while (e && e.nodeType === 1) { if ((e.matches || e.webkitMatchesSelector).call(e, s)) return e; e = e.parentNode; } return null; });
  if (window.Promise && !Promise.prototype.finally) {
    d(Promise.prototype, 'finally', { configurable: true, writable: true, value: function (f) {
      var C = this.constructor;
      return this.then(function (v) { return C.resolve(f()).then(function () { return v; }); },
                       function (e) { return C.resolve(f()).then(function () { throw e; }); });
    } });
  }
})();
