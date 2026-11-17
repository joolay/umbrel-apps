/* D-pad spatial navigation + magic-remote pointer support. Focus is a CSS class (.focus), not DOM focus. */
var Nav = (function () {
  var cur = null, root = document.body, hydrateTimer = null, onfocus = null;

  function vis(el) { return el.getClientRects().length > 0; }
  function items() { return Array.prototype.slice.call(root.querySelectorAll('.f')).filter(vis); }
  function onScreen(r) { return r.right > 0 && r.left < 1920 && r.bottom > 0 && r.top < 1080; }

  function set(el, noScroll) {
    if (cur) cur.classList.remove('focus');
    cur = el;
    if (el) { el.classList.add('focus'); if (!noScroll) reveal(el); if (onfocus) onfocus(el); }
    scheduleHydrate();
  }
  function reveal(el) {
    var p = el.parentNode, er = el.getBoundingClientRect();
    while (p && p !== document.body) {
      if (p.classList) {
        if (p.classList.contains('hs')) {
          var cr = p.getBoundingClientRect(), pad = 60;
          er = el.getBoundingClientRect();
          if (er.left < cr.left + pad) p.scrollLeft -= (cr.left + pad - er.left);
          else if (er.right > cr.right - pad) p.scrollLeft += er.right - (cr.right - pad);
        }
        if (p.classList.contains('snap')) {
          var rw = el.closest('.row');
          if (rw) { p.scrollTop += rw.getBoundingClientRect().top - p.getBoundingClientRect().top; }
        } else if (p.classList.contains('vs') || p.classList.contains('mvs')) {
          var row = el.closest('.row') || el, r = row.getBoundingClientRect(), c = p.getBoundingClientRect();
          var top = p.getAttribute('data-pad-top') ? parseInt(p.getAttribute('data-pad-top'), 10) : 110;
          if (r.height > c.height - top - 30) r = el.getBoundingClientRect();
          if (r.top < c.top + top) p.scrollTop -= (c.top + top - r.top);
          else if (r.bottom > c.bottom - 30) p.scrollTop += r.bottom - (c.bottom - 30);
        }
      }
      p = p.parentNode;
    }
  }
  function move(dir) {
    var list = items();
    if (!list.length) return;
    if (!cur || !vis(cur) || !root.contains(cur)) { set(list[0]); return; }
    var cr = cur.getBoundingClientRect(), cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2, best = null, bs = 1e12;
    list.forEach(function (el) {
      if (el === cur) return;
      var r = el.getBoundingClientRect(), ex = (r.left + r.right) / 2, ey = (r.top + r.bottom) / 2, prim, sec;
      if (dir === 'left' || dir === 'right') {
        if (dir === 'left' ? !(ex < cx - 4) : !(ex > cx + 4)) return;
        prim = Math.abs(cx - ex); sec = Math.abs(cy - ey);
        if (sec > Math.max(cr.height * 0.7, 70)) return;
        sec *= 3;
      } else {
        if (dir === 'up' ? !(ey < cy - 4) : !(ey > cy + 4)) return;
        prim = Math.abs(cy - ey); sec = Math.abs(cx - ex) * 1.6;
        if (!onScreen(r) && Math.abs(cx - ex) > 1200) return;
      }
      var sc = prim + sec;
      if (sc < bs) { bs = sc; best = el; }
    });
    if (best) set(best);
    return !!best;
  }
  function hydrate() {
    hydrateTimer = null;
    var els = document.querySelectorAll('[data-bg]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], r = el.getBoundingClientRect();
      var shown = el.getClientRects().length > 0;
      var near = shown && r.right > -500 && r.left < 2400 && r.bottom > -500 && r.top < 1700;
      var on = el.getAttribute('data-on') === '1';
      if (near && !on) { el.style.backgroundImage = 'url("' + el.getAttribute('data-bg') + '")'; el.setAttribute('data-on', '1'); }
      else if (!near && on && el.getAttribute('data-keep') !== '1') { el.style.backgroundImage = ''; el.setAttribute('data-on', '0'); }
    }
  }
  function scheduleHydrate() { if (!hydrateTimer) hydrateTimer = setTimeout(hydrate, 60); }

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest ? e.target.closest('.f') : null;
    if (el && root.contains(el) && el !== cur) set(el, true);
  });
  window.addEventListener('mousemove', function () { document.body.classList.add('pointer'); });
  document.addEventListener('keydown', function () { document.body.classList.remove('pointer'); }, true);

  return {
    onFocus: function (f) { onfocus = f; }, set: set, move: move, hydrate: scheduleHydrate, items: items,
    cur: function () { return cur; },
    setRoot: function (el, keepFocus) { root = el || document.body; if (!keepFocus) { var l = items(); set(l[0] || null); } },
    root: function () { return root; },
    first: function (sel) { var el = root.querySelector(sel || '.f'); if (el) set(el); }
  };
})();
