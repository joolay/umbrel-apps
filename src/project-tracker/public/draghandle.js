// Drag handle reordering for every JoolzApp (Glass template). One script, no dependencies: <script src="draghandle.js"></script>
// Put a handle in each tile / row:  <span class="jz-handle" data-drag role="button" aria-label="Drag to reorder" title="Drag to reorder">⋮⋮</span>
// then, once:
//   JZDrag.init(document.querySelector("#main"), {
//     item: ".p",                  // the draggable tile / row (the handle sits inside it)
//     box: ".grid,.list",          // the container whose children are reordered (tiles never leave their box)
//     enabled: function () { return !readOnly; },   // optional; false = handles do nothing
//     onStart: function () {},     // optional (e.g. cancel a press-and-hold timer)
//     onDrop: function (ids, box) {}   // ids = data-id of every item in the box, in the new order; only called when the order changed
//   });
// Works in a list (vertical, the tile only moves up and down) and in a grid with several columns (any direction): the tile follows the finger, the others make room, and the page scrolls near the top and bottom edges.
(function () {
  "use strict";
  var drag = null, raf = 0;
  function kids(box, sel) { return Array.prototype.filter.call(box.children, function (x) { return x.matches(sel); }); }
  function center(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2 + window.pageXOffset, y: r.top + r.height / 2 + window.pageYOffset }; }
  function place() {
    if (!drag) return;
    var d = drag, px = d.cx + window.pageXOffset - d.gx, py = d.cy + window.pageYOffset - d.gy;   // gx/gy: where on the tile the finger took hold
    d.el.style.transform = "translate(" + (d.lockX ? 0 : px - d.ox) + "px," + (py - d.oy) + "px)";
    var sibs = kids(d.box, d.item);
    for (var i = 0; i < sibs.length; i++) {
      var o = sibs[i]; if (o === d.el) continue;
      var b = o.getBoundingClientRect(); if (d.cx < b.left || d.cx > b.right || d.cy < b.top || d.cy > b.bottom) continue;
      var after = sibs.indexOf(d.el) < i; d.box.insertBefore(d.el, after ? o.nextSibling : o);
      d.el.style.transform = ""; var c = center(d.el); d.ox = c.x; d.oy = c.y;   // new home: the finger offset is measured from here
      d.el.style.transform = "translate(" + (d.lockX ? 0 : px - d.ox) + "px," + (py - d.oy) + "px)"; break;
    }
  }
  function tick() {
    if (!drag) return; raf = 0;
    var h = window.innerHeight, edge = 70, v = drag.cy < edge ? -(edge - drag.cy) / 4 : drag.cy > h - edge ? (drag.cy - (h - edge)) / 4 : 0;
    if (v) { window.scrollBy(0, v); place(); }
    raf = requestAnimationFrame(tick);
  }
  function finish(cancel) {
    if (!drag) return; var d = drag; drag = null; if (raf) cancelAnimationFrame(raf); raf = 0;
    d.el.classList.remove("jz-dragging"); d.el.style.transform = ""; document.documentElement.classList.remove("jz-drag-on");
    try { d.handle.releasePointerCapture(d.pid); } catch (e) {}
    var ids = kids(d.box, d.item).map(function (x) { return x.dataset.id; });
    if (!cancel && d.opts.onDrop && ids.join("|") !== d.before) d.opts.onDrop(ids, d.box);
  }
  window.JZDrag = {
    init: function (root, opts) {
      opts = opts || {}; var item = opts.item || ".p", boxSel = opts.box || ".grid,.list";
      root.addEventListener("pointerdown", function (ev) {
        var h = ev.target.closest && ev.target.closest("[data-drag]"); if (!h || ev.button > 0) return;
        if (opts.enabled && !opts.enabled()) return;
        var el = h.closest(item), box = el && el.closest(boxSel); if (!el || !box) return;
        ev.preventDefault(); ev.stopPropagation(); if (opts.onStart) opts.onStart();
        var c = center(el);
        drag = { el: el, box: box, item: item, opts: opts, handle: h, pid: ev.pointerId, ox: c.x, oy: c.y, gx: ev.clientX + window.pageXOffset - c.x, gy: ev.clientY + window.pageYOffset - c.y, cx: ev.clientX, cy: ev.clientY, before: kids(box, item).map(function (x) { return x.dataset.id; }).join("|") };
        var all = kids(box, item), l0 = all[0].getBoundingClientRect().left; drag.lockX = all.every(function (x) { return Math.abs(x.getBoundingClientRect().left - l0) < 4; });   // one column: only move up and down
        el.classList.add("jz-dragging"); document.documentElement.classList.add("jz-drag-on");
        try { h.setPointerCapture(ev.pointerId); } catch (e) {}
        place(); if (!raf) raf = requestAnimationFrame(tick);
      }, true);
      root.addEventListener("pointermove", function (ev) { if (!drag || ev.pointerId !== drag.pid) return; ev.preventDefault(); drag.cx = ev.clientX; drag.cy = ev.clientY; place(); }, true);
      root.addEventListener("pointerup", function () { finish(false); }, true);
      root.addEventListener("pointercancel", function () { finish(true); }, true);
    }
  };
})();
