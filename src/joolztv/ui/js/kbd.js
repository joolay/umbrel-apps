/* Optional big-key on-screen keyboard (Settings > On-screen keyboard). Works with the remote's arrow keys and OK, and with a pointer.
   Replaces the TV's own keyboard for every text box. ES5. */
var Kbd = (function () {
  var overlay = null, input = null, prev = null, layer = 'abc', shift = false, shown = false;
  var ICON = {
    shift: '<svg class="ico" viewBox="0 0 48 48" width="44" height="44"><path d="M24 9 9 26h9v12h12V26h9z" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/></svg>',
    bksp: '<svg class="ico" viewBox="0 0 48 48" width="44" height="44"><path d="M17 11h24a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H17L5 24z" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/><path d="m24 18 12 12M36 18 24 30" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>',
    done: '<svg class="ico" viewBox="0 0 48 48" width="44" height="44"><path d="m9 25 10 10L39 13" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function chars(str) { return str.split(''); }
  var ABC = [chars('1234567890'), chars('qwertyuiop'), chars("asdfghjkl'"), ['shift'].concat(chars('zxcvbnm'), ['bksp']), ['sym', '@', 'dotcom', 'space', '.', 'clear', 'done']];
  var SYM = [chars('1234567890'), chars('-_=+/\\:;()'), chars('!?$%&*"~`|'), chars(',.@#\'').concat(['bksp']), ['abc', 'dotcom', 'space', 'clear', 'done']];
  var SPECIAL = { shift: 1, bksp: 1, sym: 1, abc: 1, space: 1, clear: 1, done: 1, dotcom: 1 };
  function enabled() { return Store.get('kbd', 'system') === 'big'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function key(t) {
    var sp = SPECIAL[t] ? t : '', cls = 'kk f' + (sp ? ' sp sp-' + sp : '') + (sp === 'shift' && shift ? ' on' : ''), lab;
    if (sp === 'shift') lab = ICON.shift; else if (sp === 'bksp') lab = ICON.bksp; else if (sp === 'done') lab = ICON.done;
    else if (sp === 'sym') lab = '123'; else if (sp === 'abc') lab = 'abc'; else if (sp === 'space') lab = 'space'; else if (sp === 'clear') lab = 'Clear'; else if (sp === 'dotcom') lab = '.com';
    else lab = esc(shift && layer === 'abc' ? t.toUpperCase() : t);
    return '<div class="' + cls + '" data-act="kkey" data-v="' + (sp ? '' : esc(t)) + '" data-sp="' + sp + '">' + lab + '</div>';
  }
  function rows() {
    var set = layer === 'abc' ? ABC : SYM, h = '';
    set.forEach(function (r) { h += '<div class="kr">' + r.map(key).join('') + '</div>'; });
    return h;
  }
  function masked() { return input && input.type === 'password'; }
  function display() {
    var v = input ? input.value : '', box = overlay && overlay.querySelector('.kval');
    if (!box) return;
    var txt = masked() && !overlay._show ? new Array(v.length + 1).join('•') : v;
    box.innerHTML = (txt ? esc(txt) : '<span class="kph">' + esc(input && input.placeholder || '') + '</span>') + '<i class="kcaret"></i>';
  }
  function draw(keep) {
    var grid = overlay.querySelector('.kgrid'); grid.innerHTML = rows();
    var f = keep && grid.querySelector('[data-v="' + keep + '"],[data-sp="' + keep + '"]'); Nav.hydrate();
    Nav.set(f || grid.querySelector('.kk'), true);
    display();
  }
  function fire() { try { var ev = document.createEvent('Event'); ev.initEvent('input', true, true); input.dispatchEvent(ev); } catch (e) {} }
  function put(s) {
    var max = input.maxLength > 0 ? input.maxLength : 1000; if (input.value.length + s.length > max) return;
    input.value += s; fire(); display();
  }
  function open(el) {
    close(true); input = el; layer = 'abc'; shift = !el.value && (el.id === 'nm');         // names start with a capital
    prev = { root: Nav.root(), cur: Nav.cur() };
    overlay = document.createElement('div'); overlay.className = 'overlay kover'; overlay._show = false;
    overlay.innerHTML = '<div class="kbd glass"><div class="khead"><div class="klabel">' + esc(el.getAttribute('placeholder') || 'Type here') + '</div><div class="kval f" data-act="kshow"></div></div><div class="kgrid"></div></div>';
    document.getElementById('app').appendChild(overlay);
    Nav.setRoot(overlay); shown = true; draw();
    try { el.blur(); } catch (e) {}
  }
  function close(silent) {
    if (!overlay) return false;
    overlay.parentNode.removeChild(overlay); overlay = null; shown = false;
    if (prev && !silent) { Nav.setRoot(prev.root, true); if (prev.cur) Nav.set(prev.cur, true); }
    return true;
  }
  /* a key (or special key) was chosen */
  function press(el) {
    if (!overlay) return;
    var sp = el.getAttribute('data-sp'), v = el.getAttribute('data-v');
    if (sp === 'shift') { shift = !shift; return draw('shift'); }
    if (sp === 'sym') { layer = 'sym'; return draw('abc'); }
    if (sp === 'abc') { layer = 'abc'; return draw('sym'); }
    if (sp === 'bksp') { input.value = input.value.slice(0, -1); fire(); return display(); }
    if (sp === 'clear') { input.value = ''; fire(); return display(); }
    if (sp === 'space') return put(' ');
    if (sp === 'dotcom') return put('.com');
    if (sp === 'done') return finish();
    var ch = layer === 'abc' && shift ? v.toUpperCase() : v; put(ch);
    if (shift && layer === 'abc') { shift = false; draw(v); }
  }
  function finish() {
    var el = input; close();
    try { if (window.JTV_submitField) window.JTV_submitField(el); } catch (e) {}
  }
  /* a real keyboard (desktop) works too while it is open: letters type, Backspace deletes, Escape closes */
  function physical(e) {
    if (!overlay) return false;
    var c = e.keyCode;
    if (c === 8) { input.value = input.value.slice(0, -1); fire(); display(); return true; }
    if (c === 27) { close(); return true; }
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { put(e.key); return true; }
    return false;
  }
  function toggleShow() { if (masked() && overlay) { overlay._show = !overlay._show; display(); } }
  return { enabled: enabled, open: open, close: function () { return close(); }, active: function () { return shown; }, press: press, physical: physical, toggleShow: toggleShow };
})();
