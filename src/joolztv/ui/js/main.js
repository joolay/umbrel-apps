/* Boot + global key handling. */
window.FLIX_VERSION = 'v1.5.0';
(function () {
  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  var BACK = { 8: 1, 27: 1, 461: 1, 10009: 1 };
  var DEFAULT_BTN = '[data-act=wizardgo],[data-act=devicego],[data-act=signingo],[data-act=addmembergo],[data-act=saveprofile]';

  (function fit() {            // scale the 1920x1080 layout to the window (browsers, phones in landscape); a 1080p TV stays at 1
    function z() { var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080); document.documentElement.style.zoom = Math.abs(k - 1) < 0.01 ? '' : k; }
    window.addEventListener('resize', z); z();
  })();

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode, ae = document.activeElement;
    var typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    if (typing) {
      if (code === 13) {
        ae.blur(); e.preventDefault();
        if (ae.id === 'q') return Views.runSearch(ae.value.trim());
        var b = Views.current() && Views.current().el.querySelector(DEFAULT_BTN);
        if (b && (ae.id === 'pw' || ae.id === 'nm')) Views.act(b);
        return;
      }
      if (BACK[code] && code !== 8) { ae.blur(); e.preventDefault(); return; }
      if (code === 38 || code === 40) { ae.blur(); } else { return; }   // normal typing
    }
    if (Player.key(code, e)) { e.preventDefault(); return; }
    if (KEYS[code]) { e.preventDefault(); Nav.move(KEYS[code]); return; }
    if (code === 13) {
      e.preventDefault();
      var c = Nav.cur();
      if (!c) return;
      if (c.tagName === 'INPUT') { c.focus(); return; }
      window.JTV_REPEAT = !!e.repeat;
      try { if (c.hasAttribute('data-act')) Views.act(c); else c.click(); } finally { window.JTV_REPEAT = false; }
      return;
    }
    if (BACK[code]) { e.preventDefault(); if (!Views.back()) { try { window.close(); } catch (x) {} } return; }
  }, true);

  document.addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('.f') : null;
    if (c && c.tagName === 'INPUT') c.focus();
  });

  /* start-up: splash -> (first run wizard | profile picker | sign in on a new device) */
  function boot() {
    Views.splash('Starting…');
    var t0 = Date.now(), wait = function (fn) { setTimeout(fn, Math.max(0, 1100 - (Date.now() - t0))); };
    var dbg = /[?&]debugstream=([^&]+)/.exec(location.search);
    Sync.start();
    Backend.household(null).then(function (h) {
      wait(function () { if (h.empty) Views.wizard(); else if (Profiles.all().length) Views.picker(); else Views.deviceSignin(); });
    }, function (e) {
      wait(function () {
        if (e.status === 401) { if (Profiles.all().length) Views.picker(); else Views.deviceSignin(); }
        else Views.offline(e.status === 503 ? (e.message || 'JoolzTV is not ready yet.') : 'Could not reach the JoolzTV server (' + e.message + ').');
      });
    });
    if (dbg) setTimeout(function () { Player.open({ type: 'movie', id: 'tt0111161', videoId: 'tt0111161', title: 'Debug stream', _direct: decodeURIComponent(dbg[1]) }); }, 2500);
  }
  window.JTVBoot = boot;
  boot();
})();
