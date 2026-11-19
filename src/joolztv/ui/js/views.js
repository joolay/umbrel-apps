/* Views: splash, wizard, sign-in, profile picker, browse (home/movies/shows/my list), search, title page, settings, menus. */
var Resume = (function () {
  function all() { return Store.get('resume', {}); }
  return {
    get: function (vid) { return all()[vid]; },
    put: function (vid, o) {
      var a = all(); a[vid] = o;
      var keys = Object.keys(a);
      if (keys.length > 80) { keys.sort(function (x, y) { return (a[y].ts || 0) - (a[x].ts || 0); }); keys.slice(80).forEach(function (k) { delete a[k]; }); }
      Store.set('resume', a);
    },
    list: function () {
      var a = all();
      return Object.keys(a).map(function (k) { return a[k]; })
        .filter(function (r) { return !r.done && r.t > 30000 && r.d && r.t / r.d < 0.95; })
        .sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
    },
    lastFor: function (id) {
      var a = all(), best = null;
      Object.keys(a).forEach(function (k) { if (a[k].id === id && (!best || (a[k].ts || 0) > (best.ts || 0))) best = a[k]; });
      return best;
    }
  };
})();

var MyList = (function () {
  function all() { return Store.get('list', {}); }
  return {
    has: function (id) { var e = all()[id]; return !!e && !e.removed; },
    set: function (m, yes) { var a = all(); a[m.id] = { type: m.type, id: m.id, name: m.name, poster: m.poster, colId: m.colId, ts: Date.now(), removed: !yes }; Store.set('list', a); },
    items: function () { var a = all(); return Object.keys(a).map(function (k) { return a[k]; }).filter(function (e) { return !e.removed; }).sort(function (x, y) { return y.ts - x.ts; }); }
  };
})();

var Views = (function () {
  var app = document.getElementById('app'), stack = [], reg = [], seq = 0, menuEl = null, menuPrev = null, toastT = null, browseToken = 0, infoT = null;
  var TABS = [['home', 'Home'], ['movie', 'Movies'], ['series', 'TV Shows'], ['library', 'My List'], ['search', 'Search']];
  var PAGES = ['home', 'movie', 'series', 'library', 'search', 'discover', 'collections', 'settings'];
  function tabs() {
    if (Policy.onlyAllowed()) return [['home', 'Home'], ['library', 'My List'], ['search', 'Search']];      // a profile that only gets what its parents chose
    var t = Tmdb.on() ? TABS.slice(0, 4).concat(Tmdb.restricted() ? [] : [['collections', 'Collections']], TABS.slice(4)) : TABS;
    return isParent() ? t.concat([['kids', 'Kids']]) : t;                                                   // parents also get "What the kids are watching"
  }
  function isParent() { return Profiles.manageable().length > 0 && !Policy.kid(); }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, ms) {
    var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, ms || 3000);
  }
  function ref(o) { reg.push(o); return reg.length - 1; }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function avHtml(p) { var l = Profiles.all(), i = 0; for (var k = 0; k < l.length; k++) if (p && l[k].id === p.id) i = k; return Avatars.html(p, i); }
  function initial(name) { return esc(String(name || '?').charAt(0).toUpperCase()); }

  /* ---------- view stack ---------- */
  function mount(name, html, opts) {
    var top = stack[stack.length - 1];
    if (top) { top.focus = Nav.cur(); top.el.style.display = 'none'; }
    var el = document.createElement('div');
    el.className = 'view ' + (opts && opts.cls || ''); el.id = 'v' + (++seq); el.innerHTML = html;
    app.appendChild(el);
    stack.push({ name: name, el: el, focus: null, onBack: opts && opts.onBack, onClose: opts && opts.onClose });
    Nav.setRoot(el);
    return el;
  }
  function replaceAll(name, html, opts) {
    closeMenu(true);
    while (stack.length) { var v = stack.pop(); if (v.onClose) v.onClose(); app.removeChild(v.el); }
    return mount(name, html, opts);
  }
  function pop() {
    if (stack.length < 2) return false;
    var v = stack.pop(); if (v.onClose) v.onClose(); app.removeChild(v.el);
    var p = stack[stack.length - 1]; p.el.style.display = '';
    Nav.setRoot(p.el, true);
    if (p.focus && p.el.contains(p.focus)) Nav.set(p.focus); else Nav.first();
    Nav.hydrate();
    return true;
  }
  function current() { return stack[stack.length - 1]; }

  /* ---------- glass menu (modal list) ---------- */
  function menu(title, opts, onPick, hint) {
    closeMenu(true);
    menuPrev = { root: Nav.root(), cur: Nav.cur() };
    var h = '<div class="menu glass"><h3>' + esc(title) + '</h3><div class="list mvs" data-pad-top="10">';
    opts.forEach(function (o, i) {
      if (o.header) { h += '<div class="mh">' + esc(o.header) + '</div>'; return; }
      if (o.file) {                                       // a source file: the name is cropped to fit, the size sits at the right edge, the playing and preferred ones are marked
        h += '<div class="opt src f' + (o.now ? ' now' : '') + (o.pref ? ' pref' : '') + '" data-act="pick" data-i="' + i + '"><span class="q">' + esc(o.q) + '</span><span class="ol">' + esc(o.label) + '</span>' +
          (o.now ? '<span class="tagx now">\u25b6 Playing</span>' : '') + (o.pref ? '<span class="tagx pref">\u2605 Preferred</span>' : '') + '<small class="os">' + esc(o.sub || '') + '</small></div>';
        return;
      }
      h += '<div class="opt f" data-act="pick" data-i="' + i + '">' + (o.q != null ? '<span class="q">' + esc(o.q) + '</span>' : '') + esc(o.label) + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</div>';
    });
    h += '</div>' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
    menuEl = document.createElement('div'); menuEl.className = 'overlay'; menuEl.innerHTML = h;
    menuEl._opts = opts; menuEl._pick = onPick;
    app.appendChild(menuEl);
    Nav.setRoot(menuEl);
    var sel = -1, n = 0; opts.forEach(function (o) { if (o.header) return; if (o.selected) sel = n; n++; });
    if (sel > 0) { var els = menuEl.querySelectorAll('.opt'); Nav.set(els[sel]); }
  }
  function closeMenu(silent) {
    if (!menuEl) return false;
    app.removeChild(menuEl); menuEl = null;
    if (!silent && menuPrev) { Nav.setRoot(menuPrev.root, true); if (menuPrev.cur) Nav.set(menuPrev.cur, true); }
    return true;
  }

  /* ---------- shared pieces ---------- */
  function meta1(m) {
    var bits = [];
    if (m.imdbRating) bits.push('<span class="chip star">★ ' + esc(m.imdbRating) + '</span>');
    if (m.releaseInfo || m.year) bits.push('<span class="chip">' + esc(m.releaseInfo || m.year) + '</span>');
    if (m.runtime) bits.push('<span class="chip">' + esc(m.runtime) + '</span>');
    if (m.genres && m.genres.length) bits.push('<span class="chip">' + esc(m.genres.slice(0, 3).join(' · ')) + '</span>');
    return bits.join('');
  }
  function topbar(active) {
    var pr = Profiles.active(), h = '<div class="top"><div class="brand">Joolz<b>TV</b></div><div class="tabbar glass' + (tabs().length > 5 ? ' many' : '') + '">';
    tabs().forEach(function (t) { h += '<div class="tab f' + (t[0] === active ? ' on' : '') + '" data-act="page" data-p="' + t[0] + '">' + t[1] + '</div>'; });
    h += '</div>';
    if (pr) h += '<div class="who glass f" data-act="avatarmenu"><span class="av" style="position:relative;overflow:hidden;background:' + esc(pr.color) + '">' + avHtml(pr) + '</span>' + esc(pr.name) + '</div>';
    return h + '</div>';
  }
  function card(m, extra) {
    var k = ref(m), bar = '';
    if (extra && extra.pct != null) bar = '<div class="barbg"></div><div class="bar" style="width:' + Math.round(extra.pct * 206) + 'px"></div>';
    return '<div class="card f" data-act="open" data-k="' + k + '">' + (m.poster ? '<div class="img" data-bg="' + esc(m.poster) + '"></div>' : '<div class="img np"><span class="npt">' + esc(m.name || '') + '</span></div>') + bar + (extra && extra.badge ? '<div class="bdg">' + esc(extra.badge) + '</div>' : '') + '</div>';
  }
  function rowHtml(title, metas, extraFn) {
    var h = '<div class="row"><h2>' + esc(title) + '</h2><div class="hs">';
    metas.slice(0, 20).forEach(function (m) { h += card(m, extraFn ? extraFn(m) : null); });
    return h + '<span class="pad-end"></span></div></div>';
  }
  function setArt(el, url) { var a = el && el.querySelector('.art'); if (!a) return; if (url) { a.style.backgroundImage = 'url("' + url + '")'; el.classList.remove('noart'); } }
  function showInfo(m) {
    var el = document.getElementById('info'); if (!el || !m) return;
    var r = '<div class="chips" id="icp">' + (m._resume ? '<span class="chip">Resume at ' + esc(fmtTime(m._resume.t)) + '</span>' : '') + meta1(m) + '</div>';      // the facts show on every tab, also on Home, next to "Resume at"
    el.innerHTML = '<h1>' + esc(m.name) + '</h1>' + r + '<div class="desc">' + esc(m.description || '') + '</div>';
    var v = current(); if (v) setArt(v.el, m.background || m.poster);
    if (Tmdb.on() && /^tt\d+$/.test(m.id || '')) {                                                      // age rating, runtime and genre from TMDB
      el._for = m.id;
      Tmdb.title(m.type, m.id).then(function (t) {
        var box = el._for === m.id && document.getElementById('icp'); if (!box || !t) return;
        var add = certChip(t.cert);
        if (!m.runtime && t.runtime) add += '<span class="chip">' + (t.runtime >= 60 ? Math.floor(t.runtime / 60) + 'h ' + (t.runtime % 60) + 'm' : t.runtime + ' min') + '</span>';
        if ((!m.genres || !m.genres.length) && t.genres && t.genres.length) add += '<span class="chip">' + esc(t.genres.slice(0, 3).map(function (g) { return g.name || g; }).join(' \u00b7 ')) + '</span>';
        box.innerHTML = add + box.innerHTML;
      }).catch(function () {});
    }
  }
  Nav.onFocus(function (el) {
    if (!el || !el.classList || !el.classList.contains('card')) return;
    var k = el.getAttribute('data-k'); if (k == null) return;
    clearTimeout(infoT); infoT = setTimeout(function () { showInfo(reg[+k]); }, 140);
  });

  /* ---------- splash and start-up ---------- */
  function splash(msg) {
    replaceAll('splash', '<div class="splash"><div class="center"><div class="mark">Joolz<b>TV</b><small>' + esc(msg || 'Starting…') + '</small></div></div></div>', {});
  }
  function offline(message) {
    replaceAll('offline', '<div class="splash"><div class="center"><div class="form glass"><h1>Can\'t reach JoolzTV</h1><div class="sub">' + esc(message || 'Check that your server is on and this device is on the network.') + '</div>' +
      '<div class="btn primary f" data-act="retryboot">Try again</div></div></div></div>', {});
    Nav.first('.btn');
  }

  /* ---------- first-run device check: what can this device decode? ---------- */
  function deviceCheck(cont) {
    if (DeviceTest.done()) return cont();
    var finished = false;
    function leave() { if (finished) return; finished = true; cont(); }
    replaceAll('devicecheck', '<div class="splash"><div class="center"><div class="form glass" style="width:980px"><h1>Checking this device</h1><div class="sub" id="dcsub">JoolzTV is testing which video and audio formats this device can play, so every film starts the right way from the first time. It takes a few seconds.</div>' +
      '<div class="dclist" id="dclist"></div><div class="btn glass f" id="dcbtn" data-act="skipdc">Skip</div></div></div></div>', { onBack: function () { DeviceTest.skip(); leave(); return true; } });
    Nav.first('.btn');
    window._dcLeave = leave;
    var list = document.getElementById('dclist');
    DeviceTest.run(function (clip, state, r) {
      var row = document.getElementById('dc-' + clip.id);
      if (!row) { row = document.createElement('div'); row.id = 'dc-' + clip.id; row.className = 'dc run'; row.innerHTML = '<span>' + esc(clip.label) + '</span><span class="dcs">Testing…</span>'; list.appendChild(row); }
      if (state === 'done') {
        row.className = 'dc ' + (r.ok === true ? 'ok' : r.ok === false ? 'bad' : '');
        row.lastChild.textContent = r.ok === true ? 'Plays directly' : r.ok === false ? 'Will be transcoded' : 'Not tested';
      }
    }).then(function (out) {
      if (finished) return;
      var good = out.filter(function (r) { return r.ok === true; }).length, bad = out.filter(function (r) { return r.ok === false; }).length;
      var sub = document.getElementById('dcsub'), btn = document.getElementById('dcbtn');
      if (sub) sub.textContent = good + ' formats play directly on this device' + (bad ? ', ' + bad + ' will be converted by your server when needed.' : '.') + ' This is remembered, and gets better as you watch.';
      if (btn) { btn.textContent = 'Continue'; btn.className = 'btn primary f'; btn.setAttribute('data-act', 'dcdone'); Nav.set(btn); }
    }).catch(function () { DeviceTest.skip(); leave(); });      // no clips on this server, or the browser can't run the check: carry on with the usual guesses
  }

  /* ---------- sign-in, wizard, picker ---------- */
  function toggleHtml(id, label, on) { return '<div class="tog f' + (on ? ' on' : '') + '" id="' + id + '" data-act="toggle"><span>' + esc(label) + '</span><span class="sw"></span></div>'; }
  function isOn(id) { var t = document.getElementById(id); return !!t && t.classList.contains('on'); }
  function formView(name, title, sub, body, onBack) {
    replaceAll(name, '<div class="splash"><div class="center"><div class="form glass"><h1>' + esc(title) + '</h1><div class="sub">' + sub + '</div><div class="err" id="ferr"></div>' + body + '</div></div></div>', { onBack: onBack });
    Nav.first('.field');
  }
  function ferr(msg) { var e = document.getElementById('ferr'); if (e) e.textContent = msg || ''; }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  /* first run on an empty household: sign in with a JoolzApp account to create the first profile (owner) */
  function wizard() {
    formView('wizard', 'Welcome to JoolzTV', 'Sign in with your JoolzApp account to set up your household. Each person who watches uses their own JoolzApp account; you can add up to ' + Profiles.max() + ' profiles.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Password">' +
      '<div class="btn primary f" data-act="wizardgo">Sign in and continue</div><div class="btn glass f" data-act="qrwizard">Sign in with a QR code</div>', null);
  }
  function wizardGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.addProfile(em, pw, '', null).then(function (r) { wizardAfter(r, em); }).catch(function (e) { ferr(e.message); });
  }
  function wizardAfter(r, em) {
    Profiles.setAll(r.profiles); finishSignIn(r.profile.id, em, r.token);
    Backend.setToken(r.token); deviceCheck(function () { qualityStep(function () { members(true); }); });
  }
  /* a new device for an existing household: sign in with any member's account, the household comes down with it */
  function deviceSignin() {
    formView('devicesignin', 'Sign in to JoolzTV', 'Sign in with your JoolzApp account to use this household on this TV.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Password">' +
      '<div class="btn primary f" data-act="devicego">Sign in</div><div class="btn glass f" data-act="qrdevice">Sign in with a QR code</div>', null);
  }
  function deviceGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.login(em, pw).then(function (r) { return deviceAfter(r, em); }).catch(function (e) { ferr(e.message); });
  }
  function deviceAfter(r, em) {
    return Backend.household(r.token).then(function (h) {
      var me = h.profiles.filter(function (p) { return p.self; })[0];
      if (!me) throw new Error('That account is not part of this household.');
      Profiles.setAll(h.profiles); finishSignIn(me.id, em, r.token); enter(me.id);
    });
  }
  /* The sign-in is always kept on the device. How long it lasts is the server's call: 90 days since the household was last used. */
  function finishSignIn(id, email, token) {
    Store.setFor(id, 'email', email); Store.setFor(id, 'token', token);
    Profiles.setActive(id);
  }

  /* "Who's watching?" */
  function picker() {
    ++browseToken; Tmdb.forget(); Dl.stop();
    var ps = Profiles.all(), h = '<div class="splash"><div class="picker"><h1>Who\'s watching?</h1><div class="ptiles">';
    ps.forEach(function (p) {
      h += '<div class="ptile f" data-act="selprofile" data-id="' + esc(p.id) + '"><div class="pav" style="background:' + esc(p.color) + '">' + avHtml(p) + '</div><div class="pn">' + esc(p.name) + '</div>' +
        (Store.getFor(p.id, 'token', null) ? '<div class="ps">Signed in</div>' : '') + '</div>';
    });
    h += '</div></div></div>';
    replaceAll('picker', h, { onBack: function () { return !!Profiles.active() && (page('home'), true); } });
    var act = Profiles.active(), first = act && Nav.root().querySelector('.ptile[data-id="' + act.id + '"]');
    Nav.set(first || Nav.root().querySelector('.ptile'));
  }
  function selectProfile(id) {
    var p = Profiles.get(id); if (!p) return;
    var tok = Store.getFor(id, 'token', null);
    if (!tok) return signin(p);
    toast('Signing in ' + p.name + '…', 8000);
    Backend.setToken(tok); Store.setActive(id);
    Backend.me().then(function () { enter(id); }).catch(function (e) {
      Backend.setToken(null); Store.setActive(null);
      if (e.status === 401 || e.status === 403) { Store.delFor(id, 'token'); signin(p, e.status === 403 ? e.message : 'Please sign in again.'); } else offline(e.message);
    });
  }
  /* ---------- Quick Access: a PIN or pattern for this profile on this TV (checked by the server, tied to this TV) ---------- */
  var Pad = null;                                           // the pad on screen: { kind, n, code, seq, cb, title }
  function qaGet(id) { var q = Store.getFor(id, 'qa', null); return q && q.deviceId && q.deviceSecret ? q : null; }
  function qaKindName(k) { return k === 'pattern' ? 'pattern' : 'PIN'; }
  function padScreen(o) {                                   // o: { title, sub, kind, onCode(code), onBack, extra }
    Pad = { kind: o.kind, n: o.kind === 'pin6' ? 6 : 4, code: '', seq: [], cb: o.onCode, onBack: o.onBack };
    var pat = o.kind === 'pattern', h = '<div class="splash"><div class="center"><div class="form glass pad"><h1>' + esc(o.title) + '</h1><div class="sub">' + esc(o.sub || '') + '</div><div class="err" id="ferr"></div>';
    if (!pat) {
      h += '<div class="pdots" id="pdots">'; for (var i = 0; i < Pad.n; i++) h += '<span></span>'; h += '</div><div class="pkeys">';
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '\u232b'].forEach(function (k) { h += k === '' ? '<span class="pk blank"></span>' : '<div class="pk f" data-act="padk" data-k="' + k + '">' + k + '</div>'; });
      h += '</div><div class="hint">Use the number keys on your remote, or pick the digits.</div>';
    } else {
      h += '<div class="ppat" id="ppat">'; for (var d = 0; d < 9; d++) h += '<div class="pdot f" data-act="padk" data-i="' + d + '"><i></i></div>'; h += '</div>' +
        '<div class="hint">Move to a dot and press OK, in the order of your pattern (at least 4 dots).</div><div class="btn primary f" data-act="paddone">Done</div><div class="btn glass f" data-act="padclear">Start again</div>';
    }
    h += (o.extra || '') + '<div class="btn glass f" data-act="padback">Back</div></div></div></div>';
    replaceAll('pad', h, { onBack: function () { Pad = null; o.onBack(); return true; } });
    Nav.set(Nav.root().querySelector(pat ? '.pdot' : '.pk.f'));
  }
  function padPaint() {
    if (!Pad) return;
    if (Pad.kind === 'pattern') { Array.prototype.forEach.call(document.querySelectorAll('#ppat .pdot'), function (el) { var i = +el.getAttribute('data-i'), at = Pad.seq.indexOf(i); el.classList.toggle('on', at >= 0); el.setAttribute('data-n', at >= 0 ? at + 1 : ''); }); return; }
    Array.prototype.forEach.call(document.querySelectorAll('#pdots span'), function (el, i) { el.classList.toggle('on', i < Pad.code.length); });
  }
  function padAdd(d) {
    if (!Pad || Pad.kind === 'pattern' || Pad.code.length >= Pad.n) return;
    Pad.code += d; padPaint(); ferr('');
    if (Pad.code.length === Pad.n) { var cb = Pad.cb, c = Pad.code; setTimeout(function () { if (Pad) { Pad.code = ''; padPaint(); } cb(c); }, 150); }
  }
  function padDot(i) { if (!Pad || Pad.kind !== 'pattern' || Pad.seq.indexOf(i) >= 0) return; Pad.seq.push(i); padPaint(); ferr(''); }
  function padDone() {
    if (!Pad || Pad.kind !== 'pattern') return;
    if (Pad.seq.length < 4) return ferr('Join at least 4 dots.');
    var c = 'p:' + Pad.seq.join(''), cb = Pad.cb; Pad.seq = []; padPaint(); cb(c);
  }
  function padKey(code) {                                   // number keys on the remote (and Backspace to take one back)
    if (!Pad || Pad.kind === 'pattern') return false;
    var d = code >= 48 && code <= 57 ? code - 48 : code >= 96 && code <= 105 ? code - 96 : -1;
    if (d >= 0) { padAdd(String(d)); return true; }
    if (code === 8 && Pad.code.length) { Pad.code = Pad.code.slice(0, -1); padPaint(); return true; }
    return false;
  }
  function qaAskTwice(kind, title, back, done) {            // choose a code, type it again, hand it over
    padScreen({ kind: kind, title: title, sub: kind === 'pattern' ? 'Draw it with at least 4 dots.' : 'Choose ' + (kind === 'pin6' ? '6' : '4') + ' digits you will remember.', onBack: back, onCode: function (a) {
      padScreen({ kind: kind, title: 'Once more', sub: 'To make sure it is right.', onBack: back, onCode: function (b) {
        if (a !== b) { return qaAskTwice(kind, title, back, done), ferr('They did not match. Try again.'); }
        done(a);
      } });
    } });
  }
  var QA_KINDS = [{ label: '4 digit PIN', sub: 'Quickest to enter', k: 'pin4' }, { label: '6 digit PIN', sub: 'A bit harder to guess', k: 'pin6' }, { label: 'Pattern', sub: 'Join 4 or more dots', k: 'pattern' }];
  function qaDevName() { return 'JoolzTV on ' + (/Web0S|webOS/i.test(navigator.userAgent) ? 'an LG TV' : 'a browser'); }
  function qaStore(id, r, kind) { Store.setFor(id, 'qa', { deviceId: r.deviceId, deviceSecret: r.deviceSecret, kind: r.kind || kind }); Store.setFor(id, 'qaasked', 1); }
  function qaOn(id, back) {                                 // the person already has their one code: just turn it on for this TV
    toast('Turning Quick Access on…', 8000);
    Backend.quickSetup('', '', qaDevName()).then(function (r) { qaStore(id, r); toast('Quick Access is on for this TV', 5000); back(true); }).catch(function (e) { toast(e.message, 6000); back(); });
  }
  function qaSetup(id, kind, back) {                        // choose (or change) the person's one code on this TV
    qaAskTwice(kind, 'Quick Access for ' + ((Profiles.get(id) || {}).name || 'you'), back, function (code) {
      Pad = null;                                           // the keypad does nothing while it saves, so extra presses can't start a second save
      var t0 = Date.now(), tick = setInterval(function () { var n = Math.round((Date.now() - t0) / 1000); ferr(n < 6 ? 'Saving…' : 'Still saving… ' + n + ' s'); }, 1000);
      ferr('Saving…');
      Backend.quickSetup(kind, code, qaDevName()).then(function (r) {
        clearInterval(tick); qaStore(id, r, kind);
        toast('Quick Access is on for this TV', 5000); back(true);
      }).catch(function (e) { clearInterval(tick); ferr(e.message); setTimeout(function () { back(); }, 6000); });
    });
  }
  function qaChoices(have, cur) {                           // one code for the whole account: turn it on here, or set / change it
    var opts = [];
    if (have && !cur) opts.push({ label: 'Turn on for this TV', sub: 'Your ' + qaKindName(have) + ', the same on all your devices', k: 'on' });
    QA_KINDS.forEach(function (o) { opts.push({ label: have ? 'Set a new ' + o.label : o.label, sub: o.sub, k: o.k, selected: have === o.k && !!cur }); });
    return opts;
  }
  function qaMenu(id, after) {                              // Settings > Quick Access
    var cur = qaGet(id);
    Backend.quickStatus().then(function (s) { return s.kind; }, function () { return null; }).then(function (have) {
      var opts = qaChoices(have, cur);
      if (cur) opts.push({ label: 'Turn Quick Access off for this TV', k: 'off' });
      menu('Quick Access', opts, function (o) {
        if (o.k === 'off') { Backend.quickRemove(cur.deviceId).catch(function () {}); Store.delFor(id, 'qa'); toast('Quick Access is off for this TV', 4000); return after && after(); }
        if (cur) { Backend.quickRemove(cur.deviceId).catch(function () {}); Store.delFor(id, 'qa'); }
        if (o.k === 'on') return qaOn(id, function () { if (after) after(); });
        qaSetup(id, o.k, function () { if (after) after(); });
      }, 'One code for all your JoolzApp devices. Faster than a password, but less secure. 5 wrong tries switch it off on this TV.');
    });
  }
  function qaOffer(id, next) {                              // asked once per profile, right after signing in; next() brings the home screen back when it is done
    if (Store.getFor(id, 'qaasked', 0) || qaGet(id)) return;
    Store.setFor(id, 'qaasked', 1);
    Backend.quickStatus().then(function (s) { return s.kind; }, function () { return null; }).then(function (have) {
      var opts = [{ label: 'Not now', k: 'no' }].concat(have ? [{ label: 'Turn on Quick Access', sub: 'Your ' + qaKindName(have) + ', the same on all your devices', k: 'on' }] : QA_KINDS);
      menu('Add Quick Access?', opts, function (o) { if (o.k === 'no') return next(); if (o.k === 'on') return qaOn(id, next); qaSetup(id, o.k, next); }, 'Sign in to this profile with a PIN or pattern instead of your password. Faster, but less secure.');
    });
  }
  function qaSignin(id) {
    var q = qaGet(id), p = Profiles.get(id); if (!q || !p) return signin(p);
    function ask(msg) {
      padScreen({ kind: q.kind, title: 'Hi ' + p.name, sub: q.kind === 'pattern' ? 'Draw your pattern.' : 'Enter your PIN.', onBack: function () { signin(p); },
        extra: '<div class="btn glass f" data-act="padpass" data-id="' + esc(id) + '">Use my password instead</div>', onCode: function (code) {
          ferr('Signing in…');
          Backend.login('', '', null, { deviceId: q.deviceId, deviceSecret: q.deviceSecret, code: code }).then(function (r) { return signinAfter(r, Store.getFor(id, 'email', ''), id); }).catch(function (e) {
            if (e.status === 423 || (e.status === 401 && !/tries left/.test(e.message))) { Store.delFor(id, 'qa'); return signin(p, e.message); }
            ask(); ferr(e.message);
          });
        } });
      if (msg) ferr(msg);
    }
    ask();
  }
  function signin(p, msg) {
    var em = Store.getFor(p.id, 'email', '');
    formView('signin', 'Hi ' + p.name, 'Sign in with your JoolzApp account to continue.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off" value="' + esc(em) + '"><input id="pw" class="field f" type="password" placeholder="Password">' +
      (qaGet(p.id) ? '<div class="btn primary f" data-act="qasignin" data-id="' + esc(p.id) + '">Use my ' + qaKindName(qaGet(p.id).kind) + '</div>' : '') +
      '<div class="btn ' + (qaGet(p.id) ? 'glass' : 'primary') + ' f" data-act="signingo" data-id="' + esc(p.id) + '">Sign in</div><div class="btn glass f" data-act="qrsignin" data-id="' + esc(p.id) + '">Sign in with a QR code</div><div class="btn glass f" data-act="forgot">Forgot password</div><div class="btn glass f" data-act="picker">Back</div>',
      function () { picker(); return true; });
    if (msg) ferr(msg);
    if (qaGet(p.id)) Nav.set(Nav.root().querySelector('[data-act=qasignin]'));
    else if (em) Nav.set(document.getElementById('pw'));
  }
  function signinGo(id) {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.login(em, pw).then(function (r) { return signinAfter(r, em, id); }).catch(function (e) { ferr(e.message); });
  }
  function signinAfter(r, em, id) {
    return Backend.household(r.token).then(function (h) {
      var me = h.profiles.filter(function (p) { return p.self; })[0];
      if (!me || me.id !== id) throw new Error('That account belongs to a different profile. Pick that profile instead.');
      Profiles.setAll(h.profiles); finishSignIn(id, em, r.token); enter(id, r.token);
    });
  }
  function enter(id, token) {
    if (!DeviceTest.done()) { Store.setActive(id); if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token()); return deviceCheck(function () { enter(id, token); }); }
    Store.setActive(id);
    if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token());
    Api.setStreamBase('');
    Backend.household().then(function (h) { Profiles.setAll(h.profiles); Profiles.setManageable(h.manageable); Api.setPrefs(h.prefs); }).catch(function () {}).then(function () { return Tmdb.init(); }).then(function () {
      if (Store.active() !== id) return;
      Theme.load(); Dl.start(); watchLoad(); clearInterval(Watch.t); Watch.t = setInterval(function () { watchLoad(); }, 300000);
      Sync.run(function () { var v = current(); if (v && PAGES.indexOf(v.name) >= 0 && v.name === 'home') page('home'); });
      var goHome = function () { page('home'); setTimeout(function () { if (current() && current().name === 'home') qaOffer(id, function () { page('home'); }); }, 1200); };
      if (!Api.quality()) return qualityStep(goHome);          // a household set up before this question existed
      goHome();
    });
  }
  function signedOut() {                       // the server said 401: this profile must sign in again
    var id = Store.active(), p = id && Profiles.get(id);
    Backend.setToken(null); if (id) Store.delFor(id, 'token'); Store.setActive(null);
    if (p) signin(p, 'Your sign-in expired. Please sign in again.'); else picker();
  }

  /* household management (after the wizard, or from Settings): add members, rename, remove */
  function members(firstRun) {
    ++browseToken;
    var ps = Profiles.all(), h = '<div class="splash"><div class="picker"><h1>' + (firstRun ? 'Who else watches?' : 'Household') + '</h1><div class="ptiles">';
    ps.forEach(function (p) {
      h += '<div class="ptile f" data-act="editprofile" data-id="' + esc(p.id) + '"><div class="pav edit" style="background:' + esc(p.color) + '">' + avHtml(p) + '</div><div class="pen">✎</div><div class="pn">' + esc(p.name) + '</div>' +
        '<div class="ps">' + (Store.getFor(p.id, 'token', null) ? 'Signed in on this TV' : 'Not signed in here') + '</div></div>';
    });
    if (ps.length < Profiles.max()) h += '<div class="ptile f" data-act="addmember"><div class="pav add">+</div><div class="pn">Add member</div></div>';
    h += '</div><div class="btn primary f pbtn2" data-act="membersdone">Done</div></div></div>';
    replaceAll('members', h, { onBack: function () { page('home'); return true; } });
    Nav.set(Nav.root().querySelector('.ptile'));
    Backend.household().then(function (hh) {                      // who may manage whom (parents) is decided on the server
      var changed = JSON.stringify(hh.manageable || []) !== JSON.stringify(Profiles.manageable());
      Profiles.setAll(hh.profiles); Profiles.setManageable(hh.manageable);
      if (changed && current() && current().name === 'members') members(firstRun);
    }).catch(function () {});
  }
  function addMember() {
    formView('addmember', 'Add a household member', 'Each profile is one JoolzApp account. Enter that person\'s JoolzApp email and password. They stay signed in as long as anyone in the household keeps using JoolzTV.',
      '<input id="em" class="field f" type="email" placeholder="Their JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Their password">' +
      '<div class="btn primary f" data-act="addmembergo">Add to household</div><div class="btn glass f" data-act="qrmember">Sign in with a QR code</div><div class="btn glass f" data-act="membersback">Cancel</div>',
      function () { members(false); return true; });
  }
  function addMemberGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter their JoolzApp email and password.');
    ferr('Adding…');
    Backend.addProfile(em, pw, '', Backend.token()).then(function (r) { memberAfter(r, em); }).catch(function (e) { ferr(e.message); });
  }
  function memberAfter(r, em) {
    Profiles.setAll(r.profiles); Store.setFor(r.profile.id, 'email', em);
    toast(r.profile.name + ' added'); members(false);
  }

  /* ---- Sign in with a QR code: scan with a phone that is signed in to the JoolzApp Portal and tap Approve ---- */
  var qrRun = 0;
  function qrStop() { qrRun++; }
  function qrScreen(title, sub, back, done) {
    var run = ++qrRun, tries = 0;
    formView('qr', title, sub, '<div id="qrbox" class="qrbox">Making a code…</div><div class="btn glass f" data-act="qrback">Back</div>', function () { qrStop(); back(); return true; });
    window.__qrBack = function () { qrStop(); back(); };
    function alive() { return run === qrRun && document.getElementById('qrbox'); }
    function fresh() {
      Backend.qrStart().then(function (q) {
        if (!alive()) return;
        document.getElementById('qrbox').innerHTML = q.svg + '<div class="qrurl">Scan with your phone, then tap Approve.<br>No camera? Open ' + esc(q.url) + ' on a phone signed in to JoolzApp.</div>';
        ferr('');
        var until = Date.now() + (q.expiresIn || 120) * 1000;
        (function tick() {
          if (!alive()) return;
          if (Date.now() > until) { if (++tries < 5) return fresh(); return ferr('That took too long. Go back and try again.'); }
          Backend.qrPoll(q.id, q.secret).then(function (p) {
            if (!alive()) return;
            if (p.status === 'approved') { qrStop(); ferr('Approved. Signing in…'); return done({ id: q.id, secret: q.secret }); }
            if (p.status === 'denied') { qrStop(); return ferr('That was denied on the phone.'); }
            if (p.status === 'expired') return fresh();
            setTimeout(tick, 2000);
          }).catch(function () { setTimeout(tick, 3000); });
        })();
      }).catch(function (e) { if (alive()) { document.getElementById('qrbox').innerHTML = ''; ferr(e.message); } });
    }
    fresh();
  }
  var QRSUB = 'Open the JoolzApp Portal on your phone (signed in), scan this code and tap Approve.';
  function qrWizard() { qrScreen('Sign in with a QR code', QRSUB, wizard, function (qr) { Backend.addProfile('', '', '', null, qr).then(function (r) { wizardAfter(r, (r.user && r.user.email) || ''); }).catch(function (e) { ferr(e.message); }); }); }
  function qrDevice() { qrScreen('Sign in with a QR code', QRSUB, deviceSignin, function (qr) { Backend.login('', '', qr).then(function (r) { return deviceAfter(r, (r.user && r.user.email) || ''); }).catch(function (e) { ferr(e.message); }); }); }
  function qrMember() { qrScreen('Add by QR code', 'Ask them to scan this with their phone (signed in to their own JoolzApp account) and tap Approve.', addMember, function (qr) { Backend.addProfile('', '', '', Backend.token(), qr).then(function (r) { memberAfter(r, (r.user && r.user.email) || ''); }).catch(function (e) { ferr(e.message); }); }); }
  function qrSignin(p) { qrScreen('Hi ' + p.name, QRSUB, function () { signin(p); }, function (qr) { Backend.login('', '', qr).then(function (r) { return signinAfter(r, (r.user && r.user.email) || '', p.id); }).catch(function (e) { ferr(e.message); }); }); }
  function editProfile(id) {
    var p = Profiles.get(id); if (!p) return;
    var h = '<div class="center"><div class="form glass"><h1>' + esc(p.name) + '</h1><div class="sub">' + (p.owner ? 'Household owner' : 'Household member') + '</div><div class="err" id="ferr"></div>' +
      '<div class="pav" style="width:150px;height:150px;border-radius:75px;margin:0 auto 18px;background:' + esc(p.color) + '">' + avHtml(p) + '</div>' +
      '<input id="nm" class="field f" maxlength="16" placeholder="Name" autocomplete="off" value="' + esc(p.name) + '">' +
      '<div class="btn glass f" data-act="pickavatar" data-id="' + esc(id) + '">Change picture</div>' +
      parentRows(p) +
      '<div class="btn primary f" data-act="saveprofile" data-id="' + esc(id) + '">Save</div>' +
      (Profiles.all().length > 1 ? '<div class="btn glass f" data-act="delprofile" data-id="' + esc(id) + '">Remove from household</div>' : '') +
      '<div class="btn glass f" data-act="membersback">Back</div></div></div>';
    replaceAll('editprofile', '<div class="splash">' + h + '</div>', { onBack: function () { members(false); return true; } });
    Nav.first('.field');
  }
  /* choose a picture: the person's JoolzApp photo (if the account has one) or one of 24 built-in pictures */
  function avatarPage(id) {
    var p = Profiles.get(id); if (!p) return;
    var cur = p.avatar || (p.photo ? 'photo' : ''), tiles = '';
    if (p.photo) tiles += '<div class="avc f' + (cur === 'photo' ? ' on' : '') + '" data-act="setavatar" data-id="' + esc(id) + '" data-v="photo"><div class="pav"><img class="pimg" alt="" src="' + p.photo + '"></div>My photo</div>';
    Avatars.LIST.forEach(function (a) { tiles += '<div class="avc f' + (cur === a[0] ? ' on' : '') + '" data-act="setavatar" data-id="' + esc(id) + '" data-v="' + a[0] + '"><div class="pav">' + Avatars.svg(a) + '</div>' + esc(a[1]) + '</div>'; });
    replaceAll('avatars', '<div class="splash"><div class="picker"><h1>Choose a picture for ' + esc(p.name) + '</h1><div class="avgrid">' + tiles + '</div><div class="err" id="ferr"></div><div class="btn glass f pbtn2" data-act="editprofile" data-id="' + esc(id) + '">Back</div></div></div>', { onBack: function () { editProfile(id); return true; } });
    Nav.set(Nav.root().querySelector('.avc.on') || Nav.root().querySelector('.avc'));
  }
  function setAvatar(id, v) {
    Backend.setAvatar(id, v).then(function (r) {
      Profiles.setAll(Profiles.all().map(function (x) { if (x.id === id) { x.avatar = r.profile.avatar; x.photo = r.profile.photo; x.hasPhoto = r.profile.hasPhoto; } return x; }));
      toast('Picture changed'); editProfile(id);
    }).catch(function (e) { ferr(e.message); });
  }
  /* kid controls: parent accounts only (the server checks too) */
  var MODE_NAMES = { off: 'Off', block: 'Block the titles on the list', allow: 'Only the titles on the list' };
  function parentRows(p) {
    if (Profiles.manageable().indexOf(p.id) < 0) return '';
    var h = '<div class="plabel">Parental controls</div>';
    if (p.kidFlag || !p.kid) h += '<div class="btn glass f" data-act="kidflag" data-id="' + esc(p.id) + '">Kids profile: ' + (p.kid ? 'On' : 'Off') + '</div>';
    else h += '<div class="plabel2">Kids profile: On (this JoolzApp account is under 18)</div>';
    if (!p.kid) return h;
    if (Tmdb.on()) h += '<div class="btn glass f" data-act="agelimit" data-id="' + esc(p.id) + '">Age limit: ' + (p.maxAge ? 'up to ' + p.maxAge : 'none') + '</div>';
    h += '<div class="btn glass f" data-act="listmode" data-id="' + esc(p.id) + '">Title list: ' + esc(MODE_NAMES[p.mode || 'off']) + '</div>' +
      '<div class="btn glass f" data-act="titles" data-id="' + esc(p.id) + '">Manage the title list (' + (p.titleCount || 0) + ')</div>';
    return h;
  }
  function patchKid(id, patch, msg) {
    Backend.setKidMode(id, patch).then(function (r) {
      Profiles.setAll(Profiles.all().map(function (x) { if (x.id === id) { for (var k in r.profile) if (k !== 'photo') x[k] = r.profile[k]; } return x; }));
      toast(msg || 'Saved', 2500); editProfile(id);
    }).catch(function (e) { toast(e.message, 5000); });
  }
  /* the list: search to add, tap a listed title to remove */
  function titlesPage(id) {
    var p = Profiles.get(id); if (!p) return;
    var el = mount('titles', '<div class="art-shade"></div>' + topbar('') + '<div class="vs" id="main"><div class="grid"><div class="gh"><h1>' + esc(p.name) + '\u2019s list</h1><div class="desc" style="max-height:none;font-size:24px">' +
      (p.mode === 'allow' ? 'Only these titles are available to ' + esc(p.name) + '.' : p.mode === 'block' ? 'These titles are blocked for ' + esc(p.name) + '.' : 'The list is off. Turn it on under Title list in the profile.') +
      ' Choose a listed title to remove it.</div><div class="sbar" style="margin-top:14px"><input id="tq" class="field f" type="text" style="width:760px" placeholder="Search a title to add" autocomplete="off" spellcheck="false"></div></div>' +
      '<div class="gl">Search results</div><div id="tres"></div><div class="gl">On the list</div><div id="tlist"><div class="skel">Loading\u2026</div></div></div></div>', { cls: 'noart' });
    Nav.hydrate(); Nav.first('#tq');
    function drawList(titles) {
      var box = document.getElementById('tlist'); if (!box) return;
      box.innerHTML = titles.length ? titles.map(function (t) { return '<div class="card f" data-act="rmtitle" data-id="' + esc(id) + '" data-imdb="' + esc(t.imdb) + '"><div class="img" data-bg="' + esc(t.poster || '') + '"></div><div class="ccap">' + esc(t.name || t.imdb) + '<small>Remove</small></div></div>'; }).join('') : '<div class="skel">Nothing on the list yet.</div>';
      Nav.hydrate();
    }
    el._draw = drawList; el._pid = id;
    Backend.getTitles(id).then(function (r) { drawList(r.titles); }).catch(function (e) { var b = document.getElementById('tlist'); if (b) b.innerHTML = '<div class="skel">' + esc(e.message) + '</div>'; });
    var q = document.getElementById('tq'), last = '';
    q.addEventListener('input', function () {
      clearTimeout(q._t); q._t = setTimeout(function () {
        var v = q.value.trim(); if (v.length < 2 || v === last) return; last = v;
        Api.ensure().then(function () { return Api.search(v); }).then(function (metas) {
          var box = document.getElementById('tres'); if (!box) return;
          box.innerHTML = Policy.cleanMetas(metas).slice(0, 18).map(function (m) { return '<div class="card f" data-act="addtitle" data-id="' + esc(id) + '" data-k="' + ref({ imdb: m.id, name: m.name, type: m.type, poster: m.poster }) + '"><div class="img" data-bg="' + esc(m.poster || '') + '"></div><div class="ccap">' + esc(m.name) + '<small>Add</small></div></div>'; }).join('') || '<div class="skel">No results.</div>';
          Nav.hydrate();
        }).catch(function () {});
      }, 800);
    });
  }
  function listEdit(id, body, msg) {
    Backend.putTitles(id, body).then(function (r) {
      Profiles.setAll(Profiles.all().map(function (x) { if (x.id === id) x.titleCount = r.titles.length; return x; }));
      var v = current(); if (v && v.el._draw && v.el._pid === id) v.el._draw(r.titles);
      toast(msg, 2500);
    }).catch(function (e) { toast(e.message, 5000); });
  }
  /* ---------- parents: what the kids are watching, screen time, more time, hidden titles ---------- */
  var KREG = [];
  var DAILY = [30, 45, 60, 90, 120, 150, 180, 240], WINDS = ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'], EXTRA = [15];                 // one 15-minute step; when it ends the parent types the code again
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(ts) { var d = new Date(ts); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function fmtMin(m) { return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min'; }
  function agoText(ts) {
    var m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago'; var d = Math.round(h / 24); return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function limitText(daily, wd) { return (daily ? fmtMin(daily) + ' a day' : 'no daily limit') + ', ' + (wd ? 'winding down at ' + wd : 'no winding-down time'); }
  function kidsPage() {
    var token = ++browseToken;
    replaceAll('kids', '<div class="art-shade"></div>' + topbar('kids') + '<div class="vs" id="main" data-pad-top="140"><div class="settings"><h1>What the kids are watching</h1><div id="kbody"><div class="loading">Loading…</div></div></div></div>', { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
    Backend.kidsWatching().then(function (r) { if (token === browseToken) paintKids(r); }).catch(function (e) { var b = document.getElementById('kbody'); if (b && token === browseToken) b.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function paintKids(r) {
    KREG = []; var b = document.getElementById('kbody'); if (!b) return;
    var h = '<div class="srow f" data-act="klimit" data-id="all">All kids: <b>' + esc(limitText(r.all.dailyMin, r.all.windDown)) + '</b></div>';
    r.kids.forEach(function (k) {
      h += '<div class="lbl">' + esc(k.name) + ' – today ' + fmtMin(k.usedMin) + (k.dailyMin ? ' of ' + fmtMin(k.dailyMin) : '') + (k.extendedUntil ? ' · extra time until ' + hhmm(k.extendedUntil) : '') + '</div>' +
        '<div class="srow f" data-act="klimit" data-id="' + k.id + '">Screen time: <b>' + esc(limitText(k.dailyMin, k.windDown)) + '</b> ' + (k.dailyCustom || k.windCustom ? '(custom)' : '(as All kids)') + '</div>' +
        '<div class="srow f" data-act="kmore" data-id="' + k.id + '">Give ' + esc(k.name) + ' more time…</div>';
      if (!k.recent.length) { h += '<div class="hint">Nothing watched yet.</div>'; return; }
      h += '<div class="row"><div class="hs">';
      k.recent.forEach(function (w) {
        KREG.push({ w: w, k: k });
        h += '<div class="card f" data-act="ktile" data-i="' + (KREG.length - 1) + '">' + (w.poster ? '<div class="img" data-bg="' + esc(w.poster) + '"></div>' : '<div class="img np"><span class="npt">' + esc(w.name || '') + '</span></div>') +
          '<div class="barbg"></div><div class="bar" style="width:' + Math.round((w.pct || 0) * 206) + 'px"></div><div class="kcap"><b>' + esc(w.name || '') + (w.ep ? ' · ' + esc(w.ep) : '') + '</b>' + Math.round((w.pct || 0) * 100) + '% · ' + agoText(w.at) + '</div></div>';
      });
      h += '<span class="pad-end"></span></div></div>';
    });
    b.innerHTML = h; Nav.hydrate();
  }
  function kidTitleMenu(i) {
    var x = KREG[i]; if (!x) return; var w = x.w, entry = { imdb: w.imdb, name: w.name, type: w.type, poster: w.poster || '' }, all = Profiles.all().filter(function (p) { return p.kid && Profiles.manageable().indexOf(p.id) >= 0; });
    var opts = [{ label: 'Open', act: 'open' }, { label: 'Hide from all kids (undo only in Settings)', act: 'hide' }];
    all.forEach(function (k) { opts.push({ label: 'Recommend to ' + k.name, act: 'rec', ids: [k.id] }); });
    if (all.length > 1) opts.push({ label: 'Recommend to all kids', act: 'rec', ids: 'all' });
    menu(w.name + ' – ' + x.k.name + ' watched ' + Math.round((w.pct || 0) * 100) + '% ' + agoText(w.at), opts, function (o) {
      if (o.act === 'open') return detail(w.type, w.imdb, { type: w.type, id: w.imdb, name: w.name, poster: w.poster });
      if (o.act === 'hide') return Backend.kidsHide(entry).then(function () { toast('Hidden from every kids profile. Undo it in Settings > Kids.', 4500); }).catch(function (e) { toast(e.message, 5000); });
      Backend.kidsRecommend(entry, o.ids).then(function () { toast('Recommended', 3000); }).catch(function (e) { toast(e.message, 5000); });
    });
  }
  function kidLimitMenu(id) {                                   // id: a kid's profile id, or 'all'
    Backend.kidsWatching().then(function (r) {
      var k = id === 'all' ? null : r.kids.filter(function (x) { return x.id === id; })[0], name = k ? k.name : 'All kids', d = k ? k.dailyMin : r.all.dailyMin, w = k ? k.windDown : r.all.windDown;
      menu('Screen time – ' + name, [{ label: 'Total play time per day: ' + (d ? fmtMin(d) : 'no limit'), act: 'd' }, { label: 'Winding-down time (playing stops): ' + (w || 'none'), act: 'w' }].concat(k && (k.dailyCustom || k.windCustom) ? [{ label: 'Reset to All kids', act: 'reset' }] : []), function (o) {
        if (o.act === 'reset') return sendLimits(id, { dailyMin: null, windDown: null }, 'Back to the All kids setting');
        var isD = o.act === 'd', list = isD ? DAILY : WINDS, cur = isD ? d : w;
        var opts = list.map(function (v) { return { label: isD ? fmtMin(v) : v, v: v, selected: v === cur }; });
        opts.push(k ? { label: 'Same as All kids', v: undefined } : { label: isD ? 'No daily limit' : 'No winding-down time', v: null });
        menu(isD ? 'Total play time per day' : 'Winding-down time', opts, function (c) {
          var patch = {}; patch[isD ? 'dailyMin' : 'windDown'] = c.v === undefined ? null : c.v;
          sendLimits(id, patch, isD ? 'Daily limit saved' : 'Winding-down time saved');
        }, 'Only play time counts: paused video, menus and browsing do not. Warnings show at 15, 10 and 5 minutes.');
      });
    }).catch(function (e) { toast(e.message, 5000); });
  }
  function sendLimits(id, patch, msg) {
    var b = { profile: id }; for (var f in patch) b[f] = patch[f];
    Backend.kidsLimits(b).then(function () { toast(msg, 3000); var v = current(); if (v && v.name === 'kids') kidsPage(); else if (v && v.name === 'settings') settingsPage(); }).catch(function (e) { toast(e.message, 5000); });
  }
  /* the parent's own Quick Access code is asked every time more time is given */
  function askCode(title, kindOf, back, go) {
    kindOf.then(function (kind) {
      if (!kind) { toast('No Quick Access code is set up for this person. Set one in Settings > Profile.', 6000); return back(); }
      padScreen({ kind: kind, title: title, sub: kind === 'pattern' ? 'Draw your Quick Access pattern.' : 'Enter your Quick Access PIN.', onBack: back, onCode: function (c) { go(c); } });
    });
  }
  function giveMoreTime(id) {
    askCode('Quick Access \u2013 15 more minutes', Backend.quickStatus().then(function (r) { return r.kind; }, function () { return null; }), kidsPage, function (code) {
      Backend.kidsExtend({ profile: id, minutes: 15, code: code }).then(function () { toast('Added 15 min', 3500); kidsPage(); }).catch(function (e) { ferr(e.message); });
    });
  }
  function timesUp(st) {
    var why = st && st.reason === 'winddown' ? 'It is winding-down time.' : 'Today\u2019s screen time is used up.';
    replaceAll('timesup', '<div class="splash"><div class="center"><div class="form glass"><h1>Time\u2019s up</h1><div class="sub">' + why + ' See you soon!</div>' +
      '<div class="btn primary f" data-act="askparent">Ask a parent for more time</div><div class="btn glass f" data-act="page" data-p="home">Back to home</div></div></div></div>', { onBack: function () { page('home'); return true; } });
    Nav.set(Nav.root().querySelector('.btn.f'));
  }
  function askParent() {                                         // on a kid's profile: pick the parent, pick the time, the parent types their own code
    Backend.kidsParents().then(function (r) {
      if (!r.parents.length) return toast('No parent is linked to this profile', 4000);
      menu('Which parent?', r.parents.map(function (p) { return { label: p.name + (p.kind ? '' : ' (no Quick Access code yet)'), p: p }; }), function (o) {
        askCode(o.p.name + ', enter your code for 15 more minutes', Promise.resolve(o.p.kind), function () { timesUp(Policy.screen()); }, function (code) {
          Backend.kidsAskTime({ parent: o.p.id, minutes: 15, code: code }).then(function () { return Policy.init(); }).then(function () { toast('Added 15 min', 3500); page('home'); }).catch(function (e) { ferr(e.message); });
        });
      }, 'When the 15 minutes end, a parent can type their code again for another 15.');
    }).catch(function (e) { toast(e.message, 5000); });
  }
  function fillKidsSettings() {
    Backend.kidsWatching().then(function (r) {
      var a = document.getElementById('kall'), hd = document.getElementById('khid');
      if (a) a.innerHTML = 'All kids screen time: <b>' + esc(limitText(r.all.dailyMin, r.all.windDown)) + '</b>';
      if (hd) hd.innerHTML = 'Hidden from kids: <b>' + r.hiddenCount + (r.hiddenCount === 1 ? ' title' : ' titles') + '</b>';
    }).catch(function () {});
  }
  function hiddenMenu() {
    Backend.kidsHidden().then(function (r) {
      if (!r.titles.length) return toast('Nothing is hidden from the kids', 3000);
      menu('Hidden from kids \u2013 choose one to unhide', r.titles.map(function (t) { return { label: t.name || t.imdb, t: t }; }), function (o) {
        Backend.kidsUnhide(o.t.imdb).then(function () { toast('Unhidden: ' + (o.t.name || ''), 3000); settingsPage(); }).catch(function (e) { toast(e.message, 5000); });
      }, 'Only here can a hidden title be shown to the kids again.');
    }).catch(function (e) { toast(e.message, 5000); });
  }
  /* on a title page: add it to a kid's list (parents) */
  function kidsMenu(type, id, m) {
    var kids = Profiles.all().filter(function (p) { return p.kid && Profiles.manageable().indexOf(p.id) >= 0; });
    if (!kids.length) return toast('No kids profiles to manage');
    Promise.all(kids.map(function (k) { return Backend.getTitles(k.id).then(function (r) { return { k: k, mode: r.mode, listed: r.titles.some(function (t) { return t.imdb === id; }) }; }); })).then(function (st) {
      var opts = [];
      st.forEach(function (x) {
        if (x.listed) opts.push({ label: 'Remove from ' + x.k.name + '\u2019s list', act: 'rm', k: x.k });
        else if (x.mode === 'allow') opts.push({ label: 'Allow for ' + x.k.name, act: 'add', k: x.k });
        else if (x.mode === 'block') opts.push({ label: 'Block for ' + x.k.name, act: 'add', k: x.k });
        else { opts.push({ label: 'Block for ' + x.k.name + ' (turns on their block list)', act: 'block', k: x.k }); opts.push({ label: 'Allow for ' + x.k.name + ' (turns on \u201conly the titles on the list\u201d)', act: 'allow', k: x.k }); }
      });
      opts.push({ header: 'Hide or recommend' });
      opts.push({ label: 'Hide from all kids in the household (undo only in Settings)', act: 'hide' });
      st.forEach(function (x) { opts.push({ label: 'Recommend to ' + x.k.name, act: 'rec', ids: [x.k.id] }); });
      if (st.length > 1) opts.push({ label: 'Recommend to all kids', act: 'rec', ids: 'all' });
      menu('For kids', opts, function (o) {
        var entry = { imdb: id, name: m.name, type: type, poster: m.poster || '' };
        if (o.act === 'hide') return Backend.kidsHide(entry).then(function () { toast('Hidden from every kids profile. Undo it in Settings > Kids.', 4500); }).catch(function (e) { toast(e.message, 5000); });
        if (o.act === 'rec') return Backend.kidsRecommend(entry, o.ids).then(function () { toast('Recommended', 3000); }).catch(function (e) { toast(e.message, 5000); });
        if (o.act === 'rm') return listEdit(o.k.id, { remove: [id] }, 'Removed from ' + o.k.name + '\u2019s list');
        var after = function () { listEdit(o.k.id, { add: [entry] }, o.act === 'allow' || (o.act === 'add' && st.filter(function (x) { return x.k.id === o.k.id; })[0].mode === 'allow') ? 'Allowed for ' + o.k.name : 'Blocked for ' + o.k.name); };
        if (o.act === 'block' || o.act === 'allow') return Backend.setKidMode(o.k.id, { mode: o.act }).then(function (r) { Profiles.setAll(Profiles.all().map(function (x) { if (x.id === o.k.id) x.mode = r.profile.mode; return x; })); after(); }).catch(function (e) { toast(e.message, 5000); });
        after();
      }, 'Only parents see this. Block lists hide a title from that profile; allow lists give the profile only the titles on the list.');
    }).catch(function (e) { toast(e.message, 5000); });
  }
  function saveProfile(id) {
    var nm = val('nm'); if (!nm) return ferr('Enter a name.');
    Backend.renameProfile(id, nm).then(function (r) {
      Profiles.setAll(Profiles.all().map(function (p) { if (p.id === id) { p.name = r.profile.name; } return p; }));
      toast('Saved'); members(false);
    }).catch(function (e) { ferr(e.message); });
  }
  function delProfile(id) {
    Backend.removeProfile(id).then(function (r) {
      Profiles.setAll(r.profiles); Store.purgeProfile(id);
      if (id === Store.active()) { Backend.setToken(null); Store.setActive(null); toast('Profile removed'); picker(); } else { toast('Profile removed'); members(false); }
    }).catch(function (e) { ferr(e.message); });
  }

  /* ---------- browse pages ---------- */
  function page(kind) {
    closeMenu(true);
    if (!Tmdb.known() && Backend.token()) return Tmdb.init().then(function () { page(kind); });          // is TMDB set up? (asked once after signing in)
    if (kind === 'search') { LASTQ = ''; return searchPage(); }
    if (Policy.onlyAllowed() && kind !== 'home' && kind !== 'library') return page('home');
    if (kind === 'settings') return settingsPage();
    if (kind === 'discover') return searchPage();
    if (kind === 'collections') return collectionsPage();
    if (kind === 'kids') return isParent() ? kidsPage() : page('home');
    var token = ++browseToken, browse = kind !== 'library';
    replaceAll(kind, '<div class="art img"></div><div class="art-shade"></div>' + topbar(kind) + (browse ? '<div id="info"></div>' : '') +
      '<div class="vs' + (browse ? ' rows snap' : '') + '" id="main"><div class="loading">Loading…</div></div>', { cls: 'noart', onBack: function () { if (kind !== 'home') { page('home'); return true; } return false; } });
    Nav.first('.tab.on');
    Api.ensure().then(function () {
      if (token !== browseToken) return;
      if (kind === 'library') return buildLibrary(current().el, token);
      buildBrowse(kind, current().el, token);
    }).catch(function (e) {
      if (token !== browseToken) return;
      current().el.querySelector('#main').innerHTML = '<div class="empty">Could not load data: ' + esc(e.message) + '</div>';
    });
  }
  function buildBrowse(kind, el, token) {
    if (Policy.onlyAllowed()) return buildAllowed(el, token);
    var main = el.querySelector('#main'), defs = Api.catalogDefs().filter(function (d) { return kind === 'home' || d.type === kind; }).slice(0, 10), trows = Tmdb.on() ? tmdbRows(kind) : [];
    if (Tmdb.on() && Tmdb.restricted()) defs = [];                // a profile with an age limit only sees rows that TMDB has filtered for it
    main.innerHTML = '<div id="rows"></div>';
    var rows = main.querySelector('#rows'), slots = [], focused = false;
    function focusFirst() {
      if (focused || token !== browseToken) return;
      var c = rows.querySelector('.card'); if (!c) return;
      focused = true;
      if (!Nav.cur() || !Nav.root().contains(Nav.cur()) || Nav.cur().classList.contains('tab')) { Nav.set(c); showInfo(reg[+c.getAttribute('data-k')]); }
    }
    if (kind === 'home') {
      var slot0 = document.createElement('div'); rows.appendChild(slot0);
      var cont = Resume.list().slice(0, 20);
      if (cont.length) {
        slot0.innerHTML = rowHtml('Continue Watching', cont.map(function (r) { return { type: r.type, id: r.id, name: r.name, poster: r.poster, _resume: r }; }), function (m) { return { pct: m._resume.t / m._resume.d }; });
        Nav.hydrate(); focusFirst();
      }
    }
    var tslots = trows.map(function () { var s = document.createElement('div'); rows.appendChild(s); return s; });
    if (kind === 'home' && Policy.kid() && Policy.recommended().length) {
      var slotRec = document.createElement('div'); rows.insertBefore(slotRec, rows.children[1] || null);
      slotRec.innerHTML = rowHtml('Recommended by your parents', Policy.recommended().map(function (i) { return { type: i.type, id: i.imdb, name: i.name, poster: i.poster, description: '' }; })); Nav.hydrate(); focusFirst();
    }
    if (kind === 'home' && Dl.ready().length) {
      var slotR = document.createElement('div'); rows.insertBefore(slotR, rows.children[1] || null);
      slotR.innerHTML = rowHtml('Ready to watch', Dl.ready().slice(0, 12).map(function (x) { return { type: x.type, id: x.imdb, name: x.name, poster: x.poster }; })); Nav.hydrate(); focusFirst();
    }
    defs.forEach(function () { var s = document.createElement('div'); rows.appendChild(s); slots.push(s); });
    var pending = defs.length + trows.length;
    function done() { if (--pending === 0 && token === browseToken && !rows.querySelector('.row')) main.innerHTML = '<div class="empty">Nothing to show right now. Check your internet connection.</div>'; }
    trows.forEach(function (r, i) {
      r.load().then(function (items) {
        if (token !== browseToken || !items.length) return;
        tslots[i].innerHTML = r.cols ? '<div class="row"><h2>' + esc(r.title) + '</h2><div class="hs">' + items.map(colCard).join('') + '<span class="pad-end"></span></div></div>' : rowHtml(r.title, items.map(tmdbMeta)); Nav.hydrate(); focusFirst();
      }).catch(function () {}).then(done);
    });
    defs.forEach(function (d, i) {
      Api.fetchCatalog(d).then(function (metas) {
        if (token !== browseToken || !metas.length) return;
        slots[i].innerHTML = rowHtml((d.name || d.id) + ' – ' + (d.type === 'movie' ? 'Movies' : 'TV Shows'), metas);
        Nav.hydrate(); focusFirst();
      }).catch(function () {}).then(done);
    });
    Nav.hydrate();
  }
  /* a profile that only gets what its parents chose: one grid of those titles */
  function buildAllowed(el, token) {
    var main = el.querySelector('#main'), items = Policy.allowed();
    if (!items.length) { main.innerHTML = '<div class="empty">Nothing here yet. Ask a parent to choose some titles for you.</div>'; return; }
    main.innerHTML = '<div id="rows">' + rowHtml('Chosen for you', items.map(function (i) { return { type: i.type, id: i.imdb, name: i.name, poster: i.poster, description: '' }; })) + '</div>';
    Nav.hydrate();
    var c = main.querySelector('.card'); if (c) { Nav.set(c); showInfo(reg[+c.getAttribute('data-k')]); }
  }
  function buildLibrary(el, token) {
    var main = el.querySelector('#main'), items = MyList.items();
    if (!items.length) { main.innerHTML = '<div class="empty">Your list is empty. Open any title and choose “+ My List”.</div>'; return; }
    var h = '<div class="grid">';
    items.slice(0, 150).forEach(function (i) { h += i.type === 'collection' ? colCard({ id: i.colId, name: i.name, poster: i.poster }) : card({ type: i.type, id: i.id, name: i.name, poster: i.poster }); });
    main.innerHTML = h + '</div>'; Nav.hydrate();
  }

  /* ---------- search ---------- */
  /* ---------- Search + Discover in one tab: the bar and the last 5 searches on top, the Discover choices below; with nothing typed the page shows Discover ---------- */
  var Recent = {                                                            // kept on the person's account (rides the sync), each can be deleted
    key: function (q) { return String(q).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60); },
    all: function () { return Store.get('searches', {}); },
    list: function () { var m = Recent.all(); return Object.keys(m).filter(function (k) { return !m[k].del; }).sort(function (x, y) { return m[y].ts - m[x].ts; }).slice(0, 5).map(function (k) { return m[k]; }); },
    add: function (q) {
      q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80); if (q.length < 2) return;
      var m = Recent.all(), ks = Object.keys(m); m[Recent.key(q)] = { q: q, ts: Date.now() };
      if (ks.length > 30) ks.sort(function (x, y) { return m[y].ts - m[x].ts; }).slice(25).forEach(function (k) { delete m[k]; });
      Store.set('searches', m);
    },
    del: function (q) { var m = Recent.all(); m[Recent.key(q)] = { q: Recent.key(q), ts: Date.now(), del: true }; Store.set('searches', m); }
  };
  function recentPaint() {
    var box = document.getElementById('recent'), q = document.getElementById('q'); if (!box) return;
    var list = (q && q.value.trim()) ? [] : Recent.list(), h = '';
    list.forEach(function (r) { h += '<span class="rs"><span class="chip f" data-act="recent" data-q="' + esc(r.q) + '">' + esc(r.q) + '</span><span class="chip f rx" data-act="recentdel" data-q="' + esc(r.q) + '" aria-label="Remove ' + esc(r.q) + '">\u00d7</span></span>'; });
    box.innerHTML = h ? '<div class="gl">Recent searches</div>' + h : ''; Nav.hydrate();
  }
  var LASTQ = '';
  function searchPage() {
    ++browseToken; var token = browseToken, disc = Tmdb.on();
    var chips = disc ? '<span class="chip f" data-act="dtype">' + (DISC.type === 'movie' ? 'Films' : 'TV shows') + '</span><span class="chip f" data-act="dgenre">' + esc(DISC.genreName) + '</span>' +
      '<span class="chip f" data-act="dyear">' + (DISC.year || 'Any year') + '</span><span class="chip f" data-act="dsort">' + esc(SORT_NAMES[DISC.sort]) + '</span>' : '';
    replaceAll('search', '<div class="art img"></div><div class="art-shade"></div>' + topbar('search') + '<div class="vs" id="main"><div class="grid sc" id="gridp" style="padding-top:150px"><div class="sbar"><input id="q" class="field f" type="text" style="width:960px" placeholder="Search movies, TV shows and people" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="' + esc(LASTQ) + '"><div class="btn glass f mic ic" data-act="speak" aria-label="Search by voice" title="Speak">' + MIC + '</div></div><div class="hint" id="vhint"></div><div id="recent"></div>' +
      (chips ? '<div id="dchips" class="chips" style="margin:18px 0 8px 0">' + chips + '</div>' : '') + '<div id="res"></div><div id="gcards"></div><div id="gmoreh"></div></div></div>',
      { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('#q');
    var q = document.getElementById('q');
    function showMode() {                                                    // typed: search results; empty: Discover
      var typed = !!q.value.trim(), dc = document.getElementById('dchips'), gc = document.getElementById('gcards'), gm = document.getElementById('gmoreh'), rs = document.getElementById('res');
      if (dc) dc.style.display = typed ? 'none' : ''; if (gc) gc.style.display = typed ? 'none' : ''; if (gm) gm.style.display = typed ? 'none' : ''; if (rs) rs.style.display = typed ? '' : 'none';
      recentPaint();
    }
    showMode();
    if (disc) discoverLoad(token); else { var g = document.getElementById('gcards'); if (g) g.innerHTML = ''; }
    if (LASTQ.trim().length >= 2) runSearch(LASTQ.trim(), true);
    // voice typed through the TV's keyboard microphone arrives as text without Enter: search once it stops changing
    var lastQ = LASTQ.trim();
    function auto() { var v = q.value.trim(); LASTQ = q.value; showMode(); if (v.length >= 2 && v !== lastQ) { lastQ = v; runSearch(v); } else if (!v) { lastQ = ''; var rs = document.getElementById('res'); if (rs) rs.innerHTML = ''; } }
    q.addEventListener('input', function () { clearTimeout(q._t); q._t = setTimeout(auto, 900); showMode(); });
    q.addEventListener('change', auto);
  }
  var MIC = '<svg class="ico" viewBox="0 0 48 48" width="34" height="34"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><rect x="17" y="6" width="14" height="25" rx="7"/><path d="M10 23a14 14 0 0 0 28 0M24 37v6M17 43h14"/></g></svg>';
  /* Voice search. webOS has no microphone access for web apps on most TVs, so: (1) speech recognition when this browser has it; otherwise
     (2) the TV's own voice input: the microphone key on the on-screen keyboard (and the Magic Remote's) types what you say into the search box. */
  function speak() {
    var q = document.getElementById('q'), hint = document.getElementById('vhint'); if (!q) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      try {
        var r = new SR(); r.lang = Tmdb.locale ? Tmdb.locale() : (navigator.language || 'en-GB'); r.interimResults = false; r.maxAlternatives = 1;
        if (hint) hint.textContent = 'Listening\u2026 say a title or a name';
        r.onresult = function (e) { var t = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : ''; if (t) { q.value = t; if (hint) hint.textContent = '\u201c' + t + '\u201d'; runSearch(t); } };
        r.onerror = function (e) { if (hint) hint.textContent = e && e.error === 'not-allowed' ? 'Microphone access was refused. Use the microphone key on the keyboard instead.' : 'Could not hear that. Try again, or use the keyboard\u2019s microphone key.'; };
        r.onend = function () { if (hint && /Listening/.test(hint.textContent)) hint.textContent = ''; };
        r.start(); return;
      } catch (e) {}
    }
    if (Kbd.enabled()) { Kbd.open(q); if (hint) hint.textContent = 'The big keyboard has no microphone: choose the TV\u2019s own keyboard in Settings to speak.'; return; }
    q.focus();
    if (hint) hint.textContent = 'Press the microphone key on the keyboard that just opened (or hold the Magic Remote\u2019s microphone button) and say a title. The words are typed in and searched automatically.';
  }
  function runSearch(q, quiet) {
    var res = document.getElementById('res'); if (!res || !q) return; if (!quiet) Recent.add(q);
    res.innerHTML = '<div class="skel">Searching…</div>';
    var viaTmdb = Tmdb.on() && !Policy.onlyAllowed();                         // TMDB's search is checked for sources; Cinemeta's is the fallback
    var tm = Tmdb.on() ? Tmdb.search(q).catch(function () { return { people: [], titles: [] }; }) : Promise.resolve({ people: [], titles: [] });
    tm.then(function (t) {
      if (viaTmdb && ((t.titles || []).length || (t.unavailable || []).length)) return { people: t.people || [], metas: t.titles.map(tmdbMeta), other: (t.unavailable || []) };
      return Api.ensure().then(function () { return Api.search(q); }).then(function (c) { return { people: t.people || [], metas: Policy.cleanMetas(c), other: [] }; });
    }).then(function (all) {
      var metas = all.metas, ppl = Policy.onlyAllowed() ? [] : all.people, other = all.other;
      if (Policy.onlyAllowed()) metas = metas.filter(function (m) { return Policy.isAllowed(m.id); });
      if (!document.getElementById('res')) return;
      if (!metas.length && !ppl.length && !other.length) { res.innerHTML = '<div class="skel">No results for “' + esc(q) + '”.</div>'; return; }
      var h = ''; if (ppl.length) h += '<div class="gl">People</div><div class="prow">' + ppl.map(personCard).join('') + '</div>';
      if (metas.length) { if (ppl.length || other.length) h += '<div class="gl">Titles</div>'; metas.slice(0, 48).forEach(function (m) { h += card(m); }); }
      if (other.length) {                                                    // no source yet, or not out yet: kept apart so the list above is all playable
        h += '<div class="gl">Not available yet</div>';
        other.forEach(function (x) { h += card(tmdbMeta(x), { badge: x.why === 'soon' ? 'Coming soon' + (x.release ? ' \u00b7 ' + fmtDate(x.release) : '') : 'No source yet' }); });
      }
      res.innerHTML = h; Nav.hydrate();
    }).catch(function (e) { res.innerHTML = '<div class="skel">Search failed: ' + esc(e.message) + '</div>'; });
  }


  /* ---------- TMDB: rows, title extras, people, collections, discover ---------- */
  function tmdbMeta(x) { return { type: x.type, tmdb: x.tmdb, id: '', name: x.name, poster: x.poster, background: x.background, description: x.description, year: x.year, imdbRating: x.rating }; }
  function tmdbRows(kind) {
    var rows = [];
    function L(title, k, t) { rows.push({ title: title, load: function () { return Tmdb.list(k, t).then(function (r) { return r.items; }); } }); }
    function D(title, t, genre) { rows.push({ title: title, load: function () { return Tmdb.discover({ type: t, genre: genre, sort: 'popular' }).then(function (r) { return r.items; }); } }); }
    if (Tmdb.restricted()) { if (kind !== 'series') D('Films for you', 'movie'); if (kind !== 'movie') D('Kids’ TV', 'series', 10762); return rows; }
    if (kind === 'home') { L('Trending films', 'trending', 'movie'); L('Trending TV', 'trending', 'series'); L('Now in cinemas', 'now', 'movie'); L('Coming soon', 'soon', 'movie'); }
    else if (kind === 'movie') { rows.push({ title: 'Collections', cols: true, load: function () { return Tmdb.collections().then(function (r) { return r.collections.slice(0, 16); }); } }); L('Trending today', 'trending', 'movie'); L('Popular', 'popular', 'movie'); L('Top rated', 'top', 'movie'); L('Now in cinemas', 'now', 'movie'); L('Coming soon', 'soon', 'movie'); }
    else { L('Trending today', 'trending', 'series'); L('Popular', 'popular', 'series'); L('Top rated', 'top', 'series'); L('On the air', 'now', 'series'); L('Airing today', 'soon', 'series'); }
    return rows;
  }
  function openTmdb(m) {
    toast('Opening…', 6000);
    Tmdb.resolve(m.tmdb, m.type).then(function (r) { detail(r.type, r.imdb, m); }).catch(function () { toast('That title is not available here', 4000); });
  }
  /* age limit and the like: check before a title starts */
  function playChecked(info) {
    var id = info.id || '';
    if (info._direct || !/^tt\d+$/.test(id)) return Player.open(info);
    Policy.check(id, info.type).then(function (r) {
      if (r.ok) return Player.open(info);
      menu('Not available', [{ label: 'OK' }], function () {}, r.message || 'This title is not available on this profile.');
    });
  }
  function personCard(p) {
    return '<div class="pc f" data-act="person" data-id="' + esc(p.id) + '"><div class="ph img" data-bg="' + esc(p.photo || '') + '"></div><div class="n">' + esc(p.name) + '</div>' + (p.role || p.department ? '<div class="r">' + esc(p.role || p.department) + '</div>' : '') + '</div>';
  }
  /* opens the TV's Netflix app (LG webOS: the system's app launcher). In a normal browser: Netflix's own search page. It cannot jump to the title itself. */
  function launchNetflix(title) {
    var hint = 'Open the Netflix app and search for \u201c' + title + '\u201d.';
    try {
      if (window.PalmServiceBridge) {
        var br = new PalmServiceBridge();
        br.onservicecallback = function (r) { try { if (JSON.parse(r).returnValue === false) toast('Could not open Netflix from here. ' + hint, 7000); } catch (e) {} };
        br.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: 'netflix' }));
        return toast('Opening Netflix\u2026 ' + hint, 6000);
      }
    } catch (e) { return toast('Could not open Netflix from here. ' + hint, 7000); }
    try { window.open('https://www.netflix.com/search?q=' + encodeURIComponent(title), '_blank'); } catch (e) { toast(hint, 6000); }
  }
  /* ---------- download ahead ---------- */
  function dlButton(el) {
    var b = el && el.querySelector('#dlbtn'), D = el && el._detail; if (!b || !D) return;
    var j = Dl.forVideo(D.play.videoId || D.id);
    b.textContent = !j ? 'Download ahead' : j.status === 'ready' ? '\u2713  Downloaded' : j.status === 'failed' ? 'Download failed, try again' : j.status === 'paused' ? 'Paused while you watch' : 'Downloading ' + Dl.pct(j) + '%';
  }
  Dl.onChange(function () { var v = current(); if (v && v.name === 'detail') dlButton(v.el); });
  function dlAhead(el) {
    var D = el._detail; if (!D) return;
    var info = D.play, vid = info.videoId || D.id, j = Dl.forVideo(vid);
    if (j && j.status !== 'failed') {
      return menu(Dl.title(j), [{ label: j.status === 'ready' ? 'Remove from the downloads list (the file stays in the cache until it is needed)' : 'Cancel this download', k: 'x' }], function () { Dl.remove(j.id).then(function () { toast(j.status === 'ready' ? 'Removed' : 'Cancelled'); dlButton(el); }); }, Dl.state(j));
    }
    toast('Finding the best source\u2026', 15000);
    Api.ensure().then(function () { return Api.getStreams(D.type, vid); }).then(function (res) {
      var s = res.list[0]; if (!s || !s.infoHash) return toast('No source found to download', 5000);
      return Dl.add({ imdb: D.id, type: D.type, videoId: vid, name: D.m.name, sub: info.sub || '', poster: D.m.poster || '', infoHash: s.infoHash, fileIdx: s.fileIdx == null ? -1 : s.fileIdx, region: Tmdb.region() }).then(function (r) {
        toast((res.hasPreferred ? '' : res.preferred + ' is not available, so ') + 'downloading \u201c' + D.m.name + '\u201d' + (s._cat ? ' (' + s._cat + ')' : '') + '. You will be told here when it is ready.', 7000);
        return Dl.refresh().then(function () { dlButton(el); });
      });
    }).catch(function (e) { toast(e.message || 'Could not start the download', 6000); });
  }
  function certChip(c) { return c && c.rating ? '<span class="chip cert">' + esc(c.rating) + '</span>' : ''; }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return '';
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
    return +m[3] + ' ' + mo + ' ' + m[1];
  }
  function enrichDetail(el, type, id, m) {
    if (!Tmdb.on() || !/^tt\d+$/.test(id)) return;
    Tmdb.title(type, id).then(function (t) {
      if (!current() || current().el !== el || !el.parentNode) return;
      el._tm = t; var d = el.querySelector('.dtop'); if (!d) return;
      el.classList.add('tm');
      if (t.background) setArt(el, t.background);
      var h1 = d.querySelector('h1'); if (h1 && t.logo) h1.innerHTML = '<img class="dlogo" alt="' + esc(t.name) + '" src="' + esc(t.logo) + '">';
      var chips = d.querySelector('.chips'), add = certChip(t.cert);
      if (!m.runtime && t.runtime) add += '<span class="chip">' + (t.runtime >= 60 ? Math.floor(t.runtime / 60) + 'h ' + (t.runtime % 60) + 'm' : t.runtime + ' min') + '</span>';
      if (t.stinger && (t.stinger.during || t.stinger.after)) add += '<span class="chip">Stay for an extra scene</span>';
      if (t.type === 'series') {
        if (t.nextEpisode) add += '<span class="chip">Next: S' + t.nextEpisode.season + ':E' + t.nextEpisode.episode + (t.nextEpisode.air ? ' · ' + esc(fmtDate(t.nextEpisode.air)) : '') + '</span>';
        else if (t.status === 'Ended' || t.status === 'Canceled') add += '<span class="chip">' + esc(t.status === 'Ended' ? 'Ended' : 'Cancelled') + '</span>';
      }
      if (chips) chips.innerHTML = add + chips.innerHTML;
      var desc = d.querySelector('.desc');
      if (desc && t.overview && (!m.description || Tmdb.locale().slice(0, 2) !== 'en')) desc.textContent = t.overview;
      if (t.tagline && chips) { var tg = document.createElement('div'); tg.className = 'tag'; tg.textContent = t.tagline; chips.parentNode.insertBefore(tg, chips.nextSibling); }
      if (t.directors && t.directors.length && desc) { var cr = document.createElement('div'); cr.className = 'credit'; cr.textContent = t.directorLabel + ' ' + t.directors.map(function (x) { return x.name; }).join(', '); desc.parentNode.insertBefore(cr, desc.nextSibling); }
      addDetailTabs(el, t);
      if (t.netflix && !Policy.kid() && !el.querySelector('.nflx')) {                    // a discreet note, not for kids profiles (Netflix has its own profiles and no JoolzTV limits)
        var nf = document.createElement('div'); nf.className = 'nflx glass f'; nf.setAttribute('data-act', 'netflix'); nf.setAttribute('data-title', t.name || m.name || ''); nf.textContent = 'Also on Netflix'; el.appendChild(nf); Nav.hydrate();
      }
      var sel = el.querySelector('#seasons .chip.on[data-s]'); if (sel && t.type === 'series') stillsFor(el, +sel.getAttribute('data-s'));
    }).catch(function () {});
  }
  /* Cast / More like this / Collection: tabs next to the seasons (series), or in the empty bottom half (films) */
  function addDetailTabs(el, t) {
    var tabsH = '';
    if (t.cast && t.cast.length) tabsH += '<span class="chip f" data-act="xtab" data-t="cast">Cast</span>';
    if (t.similar && t.similar.length) tabsH += '<span class="chip f" data-act="xtab" data-t="similar">More like this</span>';
    if (t.collection) tabsH += '<span class="chip f" data-act="collection" data-id="' + esc(t.collection.id) + '">' + esc(t.collection.name) + '</span>';
    if (!tabsH) return;
    var bar = el.querySelector('#seasons');
    if (!bar) {
      var w = document.createElement('div'); w.className = 'eps-wrap'; w.innerHTML = '<div class="seasons" id="seasons">' + tabsH + '</div><div class="eps hs" id="eplist"></div>'; el.appendChild(w);
      xTab(el, t.cast && t.cast.length ? 'cast' : 'similar');
    } else bar.insertAdjacentHTML('beforeend', tabsH);
    Nav.hydrate();
    placeTabs(el);
    var lg = el.querySelector('.dlogo'); if (lg && !lg.complete) lg.onload = function () { placeTabs(el); };      // a title logo changes the height of the text above
  }
  /* A long tagline, credit line or logo can push the buttons down into the tabs and cards below: keep them under the buttons. */
  function placeTabs(el) {
    var b = el.querySelector('.btns'), w = el.querySelector('.eps-wrap'); if (!b || !w) return;
    var top = 0, n = b; while (n && n !== el && n !== document.body) { top += n.offsetTop || 0; n = n.offsetParent; }
    var at = Math.max(560, top + b.offsetHeight + 24), list = el.querySelector('#eplist');
    w.style.top = at + 'px'; w.style.height = (1080 - at) + 'px';
    if (list) list.style.height = Math.min(440, 1080 - at - 70) + 'px';
  }
  function xTab(el, which) {
    var t = el._tm; if (!t) return;
    var list = el.querySelector('#eplist'), h = '';
    if (which === 'cast') t.cast.forEach(function (p) { h += personCard(p); });
    else t.similar.forEach(function (x) { h += card(tmdbMeta(x)); });
    list.scrollLeft = 0; list.innerHTML = h + '<span class="pad-end"></span>';
    Array.prototype.forEach.call(el.querySelectorAll('#seasons .chip'), function (c) { c.classList.toggle('on', c.getAttribute('data-t') === which); });
    Nav.hydrate();
  }
  function stillsFor(el, season) {                                   // episode pictures and summaries where Cinemeta has none
    var t = el._tm; if (!t || !t.tmdb || t.type !== 'series' || !season) return;
    Tmdb.season(t.tmdb, season).then(function (r) {
      if (!el.parentNode) return;
      r.episodes.forEach(function (e) {
        var ep = el.querySelector('.ep[data-ep="' + e.episode + '"]'); if (!ep) return;
        var im = ep.querySelector('.img'); if (im && e.still && !im.getAttribute('data-has')) { im.setAttribute('data-bg', e.still); im.style.backgroundImage = 'url("' + e.still + '")'; }
        var o = ep.querySelector('.o'); if (o && !o.textContent && e.overview) o.textContent = e.overview;
      });
    }).catch(function () {});
  }
  /* generic page of cards (collection, person, genre results) */
  function gridView(name, head, items, pager) {
    var h = '<div class="art-shade"></div>' + topbar('') + '<div class="vs" id="main"><div class="grid" id="gridp"><div class="gh">' + head + '</div><div id="gcards">';
    items.forEach(function (x) { h += card(tmdbMeta(x)); });
    h += '</div>' + (pager ? '<div class="btn glass f" id="gmore" data-act="gmore">More</div>' : '') + '</div></div>';
    var el = mount(name, h, { cls: 'noart' }); Nav.hydrate(); Nav.first('.card'); return el;
  }
  function personPage(id) {
    toast('Loading…', 6000);
    Tmdb.person(id).then(function (p) {
      var head = '<div class="pphoto img" data-bg="' + esc(p.photo || '') + '"></div><div class="ptext"><h1>' + esc(p.name) + '</h1><div class="chips">' + (p.department ? '<span class="chip">' + esc(p.department) + '</span>' : '') +
        (p.born ? '<span class="chip">Born ' + esc(fmtDate(p.born) || p.born) + '</span>' : '') + (p.place ? '<span class="chip">' + esc(p.place.slice(0, 40)) + '</span>' : '') + '</div><div class="desc">' + esc(p.bio) + '</div></div>';
      gridView('person', head, p.known, false);
    }).catch(function () { toast('Could not load that person', 4000); });
  }
  function collectionPage(id) {
    toast('Loading…', 6000);
    Tmdb.collection(id).then(function (c) {
      var entry = { id: 'col:' + c.id, colId: c.id, type: 'collection', name: String(c.name || '').replace(/ Collection$/, ''), poster: c.poster || '' };
      var el = gridView('collection', '<div class="ptext"><h1>' + esc(c.name) + '</h1><div class="desc">' + esc(c.overview) + '</div><div class="btns"><div class="btn glass f" data-act="togglecol" id="colbtn">' + (MyList.has(entry.id) ? '\u2713  In My List' : '+  My List') + '</div></div></div>', c.items, false);
      el._col = entry; Nav.hydrate();
    }).catch(function () { toast('Could not load that collection', 4000); });
  }
  /* ---------- Collections: film franchises (Star Wars, Harry Potter, ...) ---------- */
  function colCard(c) {
    return '<div class="card f" data-act="collection" data-id="' + esc(c.id) + '"><div class="img" data-bg="' + esc(c.poster || '') + '"></div><div class="ccap">' + esc(c.name.replace(/ Collection$/, '')) + (c.count ? '<small>' + c.count + ' films</small>' : '') + '</div></div>';
  }
  function collectionsPage() {
    var token = ++browseToken;
    replaceAll('collections', '<div class="art-shade"></div>' + topbar('collections') + '<div class="vs" id="main"><div class="grid" id="gridp"><div class="gh"><h1>Collections</h1><div class="sbar"><input id="cq" class="field f" type="text" style="width:700px" placeholder="Search collections (Bond, Toy Story)" autocomplete="off" spellcheck="false"></div></div><div id="gcards"><div class="skel">Loading…</div></div></div></div>',
      { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
    function load(q) {
      Tmdb.collections(q).then(function (r) {
        if (token !== browseToken) return;
        var box = document.getElementById('gcards'); if (!box) return;
        box.innerHTML = r.collections.length ? r.collections.map(colCard).join('') : '<div class="skel">No collections found.</div>'; Nav.hydrate();
      }).catch(function (e) { var b = document.getElementById('gcards'); if (b) b.innerHTML = '<div class="skel">Could not load: ' + esc(e.message) + '</div>'; });
    }
    var cq = document.getElementById('cq'), last = '';
    cq.addEventListener('input', function () { clearTimeout(cq._t); cq._t = setTimeout(function () { var v = cq.value.trim(); if (v !== last && (v.length >= 2 || !v)) { last = v; load(v); } }, 700); });
    load('');
  }
  var DISC = { type: 'movie', genre: '', genreName: 'Any genre', year: '', sort: 'popular', page: 1 };
  var SORT_NAMES = { popular: 'Most popular', rating: 'Highest rated', newest: 'Newest', az: 'A to Z' };
  function discoverPage() { return searchPage(); }
  function discoverLoad(token) {
    token = token || browseToken;
    Tmdb.discover({ type: DISC.type, genre: DISC.genre, year: DISC.year, sort: DISC.sort, page: DISC.page }).then(function (r) {
      if (token !== browseToken) return;
      var h = ''; r.items.forEach(function (x) { h += card(tmdbMeta(x)); });
      var box = document.getElementById('gcards'); if (!box) return;
      if (DISC.page > 1) box.insertAdjacentHTML('beforeend', h); else box.innerHTML = h || '<div class="skel">Nothing matches those choices.</div>';
      var more = document.getElementById('gmoreh'); if (more) more.innerHTML = r.pages > DISC.page ? '<div class="btn glass f" data-act="dmore">More</div>' : '';
      Nav.hydrate();
    }).catch(function (e) { var b = document.getElementById('gcards'); if (b) b.innerHTML = '<div class="skel">Could not load: ' + esc(e.message) + '</div>'; });
  }
  function discoverMenu(a) {
    if (a === 'dtype') { DISC.type = DISC.type === 'movie' ? 'series' : 'movie'; DISC.genre = ''; DISC.genreName = 'Any genre'; DISC.page = 1; return discoverPage(); }
    if (a === 'dsort') return menu('Sort by', Object.keys(SORT_NAMES).map(function (k) { return { label: SORT_NAMES[k], k: k, selected: k === DISC.sort }; }), function (o) { DISC.sort = o.k; DISC.page = 1; discoverPage(); });
    if (a === 'dyear') { var ys = [{ label: 'Any year', y: '' }], y = new Date().getFullYear(); for (var i = 0; i < 40; i++) ys.push({ label: String(y - i), y: String(y - i) }); ys.forEach(function (o) { o.selected = o.y === DISC.year; }); return menu('Year', ys, function (o) { DISC.year = o.y; DISC.page = 1; discoverPage(); }); }
    if (a === 'dgenre') return Tmdb.genres(DISC.type).then(function (r) { var os = [{ label: 'Any genre', g: '', n: 'Any genre' }].concat(r.genres.map(function (g) { return { label: g.name, g: String(g.id), n: g.name }; })); os.forEach(function (o) { o.selected = o.g === DISC.genre; }); menu('Genre', os, function (o) { DISC.genre = o.g; DISC.genreName = o.n; DISC.page = 1; discoverPage(); }); });
  }

  /* ---------- title page ---------- */
  function detail(type, id, seed) {
    var el = mount('detail', '<div class="art img"></div><div class="art-shade"></div><div class="dtop"><h1>' + esc(seed && seed.name || '') + '</h1><div class="chips"><span class="chip">Loading…</span></div></div>', { cls: 'noart' });
    setArt(el, seed && (seed.background || seed.poster));
    Nav.hydrate();
    Api.ensure().then(function () { return Promise.all([Api.getMeta(type, id), /^tt\d+$/.test(id) ? Policy.check(id, type) : { ok: true }]); }).then(function (r) {
      var m = r[0], dec = r[1];
      if (current().el !== el) return;
      if (Policy.adultMeta(m)) dec = { ok: false, reason: 'adult', message: 'This title is blocked on JoolzTV for everyone (adult content).' };
      if (!dec.ok) return renderBlocked(el, m, dec);
      renderDetail(el, type, id, m);
    }).catch(function (e) {
      var d = el.querySelector('.dtop'); if (d) d.innerHTML = '<h1>' + esc(seed && seed.name || '') + '</h1><div class="chips"><span class="chip">Could not load details: ' + esc(e.message) + '</span></div>';
    });
  }
  function renderBlocked(el, m, dec) {
    var d = el.querySelector('.dtop');
    d.innerHTML = '<h1>' + esc(m && m.name || '') + '</h1><div class="chips"><span class="chip cert">Not available</span></div><div class="desc">' + esc(dec.message || 'This title is not available on this profile.') + '</div>' +
      '<div class="btns"><div class="btn primary f" data-act="detailback">Back</div></div>';
    Nav.hydrate(); Nav.first('.btn');
  }
  /* unreleased episodes: greyed out with the date; "Notify me" asks the server to look for a source after the release time */
  var Watch = { items: {}, loaded: false };
  function relMs(v) { var t = v && v.released ? Date.parse(v.released) : NaN; return isNaN(t) ? 0 : t; }
  function unreleased(v) { return relMs(v) > Date.now(); }
  function watchLoad(cb) { if (!Backend.token()) return cb && cb(); Backend.call('GET', '/api/notify', undefined, undefined, 10000).then(function (j) { Watch.items = {}; (j.items || []).forEach(function (w) { Watch.items[w.videoId] = w; }); Watch.loaded = true; announceWatch(j.items || []); if (cb) cb(); }).catch(function () { if (cb) cb(); }); }
  var toldWatch = {};
  function announceWatch(items) { items.forEach(function (w) { if (w.status !== 'ready' || w.notified || toldWatch[w.id]) return; toldWatch[w.id] = 1; toast('Now available: ' + (w.name || '') + ' ' + (w.sub || '') + (w.ahead ? ' (downloading)' : ' (the first minute is ready)'), 9000); Backend.call('POST', '/api/notify/' + w.id + '/seen', {}).catch(function () {}); }); }
  function notifyState(v) { var w = Watch.items[v.id]; return !w ? 0 : w.ahead ? 2 : 1; }
  function notifyCycle(v, info) {                                           // off -> notify me -> notify and download ahead -> off
    var st = notifyState(v), w = Watch.items[v.id], done = function () { var el = current().el; if (el && el._detail) renderEpisodes(el, v.season); };
    if (st === 2) { Backend.call('DELETE', '/api/notify/' + w.id).then(function () { delete Watch.items[v.id]; toast('Reminder removed', 3000); done(); }).catch(function (e) { toast(e.message || 'Could not remove', 4000); }); return; }
    Backend.call('POST', '/api/notify', { imdb: info.id, videoId: v.id, name: info.title, sub: info.sub, poster: info.poster, releaseAt: relMs(v), ahead: st === 1, region: Tmdb.region() || '' }).then(function (j) {
      Watch.items[v.id] = j.item; toast(st === 1 ? 'We will download it as soon as it is out' : 'We will tell you when it is out, and have the first minute ready', 5000); done();
    }).catch(function (e) { toast(e.message || 'Could not set a reminder', 5000); });
  }
  function seasonsOf(m) {
    var by = {};
    (m.videos || []).forEach(function (v) { var s = v.season == null ? 0 : v.season; (by[s] = by[s] || []).push(v); });
    var keys = Object.keys(by).map(Number).sort(function (a, b) { return (a === 0) - (b === 0) || a - b; });
    keys.forEach(function (k) { by[k].sort(function (a, b) { return (a.episode || a.number || 0) - (b.episode || b.number || 0); }); });
    return { by: by, keys: keys };
  }
  function renderDetail(el, type, id, m) {
    var isSeries = type === 'series' && m.videos && m.videos.length, S = isSeries ? seasonsOf(m) : null;
    var last = Resume.lastFor(id), playVid = id, playLabel = '▶  Play', start = 0, sub = '';
    var flat = [];
    function getNext(vid) {
      for (var q = 0; q < flat.length - 1; q++) if (flat[q].id === vid) {
        var n = flat[q + 1]; if (n.season === 0 && flat[q].season > 0) return null; if (unreleased(n)) return null;
        return { videoId: n.id, sub: 'S' + n.season + ':E' + n.episode, epTitle: n.title || n.name, startMs: 0 };
      }
      return null;
    }
    var baseInfo = { type: type, id: id, title: m.name, poster: m.poster, getNext: isSeries ? getNext : null };
    var season = S ? (S.keys.filter(function (k) { return k > 0; })[0] || S.keys[0]) : null;
    if (isSeries) {
      S.keys.forEach(function (k) { flat = flat.concat(S.by[k]); });
      var first = flat.filter(function (v) { return v.season > 0; })[0] || flat[0];
      playVid = first.id; sub = 'S' + first.season + ':E' + first.episode; season = first.season != null ? first.season : season;
      if (last) {
        if (!last.done) { playVid = last.videoId; start = last.t; playLabel = '▶  Resume'; sub = 'S' + last.season + ':E' + last.episode; season = last.season != null ? last.season : season; }
        else { for (var i = 0; i < flat.length; i++) if (flat[i].id === last.videoId && flat[i + 1] && !unreleased(flat[i + 1])) { playVid = flat[i + 1].id; sub = 'S' + flat[i + 1].season + ':E' + flat[i + 1].episode; season = flat[i + 1].season; } }
      }
    } else if (last && !last.done) { start = last.t; playLabel = '▶  Resume'; }
    else if (last && last.done) { playLabel = '\u21ba  Watch again'; }                                  // reached the credits: watched, start over on request
    var info = Object.assign({}, baseInfo, { videoId: playVid, startMs: start });
    if (isSeries) info.sub = sub;
    var k = ref(info), k2 = ref(Object.assign({}, info, { pick: true })), k3 = ref(Object.assign({}, info, { startMs: 0 }));
    var watched = !!(last && last.done) && !isSeries, restart = start > 0;                              // an unfinished one can also be started from the beginning
    var h = '<h1>' + esc(m.name) + '</h1><div class="chips">' + (watched ? '<span class="chip">\u2713 Watched</span>' : '') + meta1(m) + '</div><div class="desc">' + esc(m.description || '') + '</div>' +
      '<div class="btns"><div class="btn primary f" data-act="play" data-k="' + k + '">' + playLabel + (isSeries && sub ? '  ' + sub : '') + '</div>' +
      (restart ? '<div class="btn glass f" data-act="play" data-k="' + k3 + '">\u21ba  Play from beginning</div>' : '') +
      '<div class="btn glass f" data-act="play" data-k="' + k2 + '">Choose source</div>' +
      '<div class="btn glass f" data-act="togglelib" id="libbtn">' + (MyList.has(id) ? '✓  In My List' : '+  My List') + '</div>' +
      '<div class="btn glass f" data-act="dlahead" id="dlbtn">Download ahead</div>' +
      (Profiles.all().some(function (p) { return p.kid && Profiles.manageable().indexOf(p.id) >= 0; }) ? '<div class="btn glass f" data-act="kidsmenu">For kids</div>' : '') + '</div>';
    el.querySelector('.dtop').innerHTML = h;
    el._detail = { type: type, id: id, m: m, S: S, base: baseInfo, play: info };
    if (isSeries && flat.some(unreleased)) watchLoad(function () { if (current().el === el) renderEpisodes(el, season); });
    Dl.refresh().then(function () { dlButton(el); });
    setArt(el, m.background || m.poster);
    if (isSeries) {
      var w = document.createElement('div'); w.className = 'eps-wrap';
      var c = '<div class="seasons" id="seasons">';
      S.keys.forEach(function (s) { c += '<span class="chip f' + (s === season ? ' on' : '') + '" data-act="season" data-s="' + s + '">' + (s === 0 ? 'Specials' : 'Season ' + s) + '</span>'; });
      w.innerHTML = c + '</div><div class="eps hs" id="eplist"></div>';
      el.appendChild(w);
      renderEpisodes(el, season);
    }
    Nav.hydrate(); Nav.first('.btn');
    enrichDetail(el, type, id, m);
  }
  function renderEpisodes(el, season) {
    var D = el._detail, list = el.querySelector('#eplist'), eps = D.S.by[season] || [], h = '';
    eps.forEach(function (v) {
      var r = Resume.get(v.id), pct = r && r.d ? Math.min(1, r.t / r.d) : 0;
      var info = Object.assign({}, D.base, { videoId: v.id, startMs: r && !r.done ? r.t : 0, sub: 'S' + v.season + ':E' + v.episode, epTitle: v.title || v.name });
      if (unreleased(v)) {
        var ns = notifyState(v), lab = ns === 2 ? 'We will download it when it is out' : ns === 1 ? 'Reminder on (first minute)' : 'Notify me';
        h += '<div class="ep glass f unrel' + (ns ? ' on' : '') + '" data-ep="' + (v.episode || v.number || '') + '" data-act="notify" data-k="' + ref(info) + '"><div class="img" data-bg="' + esc(v.thumbnail || D.m.background || '') + '"' + (v.thumbnail ? ' data-has="1"' : '') + '></div>' +
          '<div class="t">' + (v.episode || v.number || '') + '. ' + esc(v.title || v.name || 'Episode') + '</div><div class="o">Releases ' + esc(fmtDate(v.released)) + '</div><div class="nb">' + esc(lab) + '</div></div>';
        return;
      }
      h += '<div class="ep glass f" data-ep="' + (v.episode || v.number || '') + '" data-act="play" data-k="' + ref(info) + '"><div class="img" data-bg="' + esc(v.thumbnail || D.m.background || '') + '"' + (v.thumbnail ? ' data-has="1"' : '') + '></div>' +
        '<div class="t">' + (r && r.done ? '\u2713 ' : '') + (v.episode || v.number || '') + '. ' + esc(v.title || v.name || 'Episode') + '</div><div class="o">' + esc(v.overview || v.description || '') + '</div>' +
        (pct > 0.02 ? '<div class="bar" style="width:' + Math.round(pct * 440) + 'px"></div>' : '') + '</div>';
    });
    list.scrollLeft = 0;
    list.innerHTML = (h || '<div class="skel">No episodes.</div>') + '<span class="pad-end"></span>';
    Array.prototype.forEach.call(el.querySelectorAll('.chip[data-s]'), function (c) { c.classList.toggle('on', Number(c.getAttribute('data-s')) === Number(season)); });
    Array.prototype.forEach.call(el.querySelectorAll('.chip[data-t]'), function (c) { c.classList.remove('on'); });
    Nav.hydrate(); stillsFor(el, season);
  }

  /* ---------- preferred quality (first run, or a household set up before the question existed) ---------- */
  var QUALITY_INFO = [['4K', 'Sharpest picture. Big files: needs a 4K screen and a fast connection.'], ['1080p', 'A great picture on most screens. Recommended.'], ['720p', 'Smaller files: starts quickly and suits a slower connection.']];
  function savePrefs(patch, cb) {
    Backend.savePrefs(patch).then(function (r) { Api.setPrefs(r.prefs); if (cb) cb(); }).catch(function (e) { toast(e.message || 'Could not save', 5000); });
  }
  function qualityStep(cont) {
    window._qcont = cont;
    var body = QUALITY_INFO.map(function (q) { return '<div class="btn glass f qopt" data-act="setquality" data-q="' + q[0] + '"><b>' + q[0] + '</b><small>' + esc(q[1]) + '</small></div>'; }).join('');
    formView('quality', 'Preferred quality', 'When something starts by itself, JoolzTV plays the file in this quality that has the most seeds. If it is not available for a title, you are told and shown the alternatives. Change it any time in Settings.', body, null);
    Nav.set(Nav.root().querySelector('[data-q="1080p"]'));
  }

  /* ---------- Sources: which files are offered (shared by the whole household) ---------- */
  function srow(act, k, label, value) { return '<div class="srow f" data-act="' + act + '" data-k="' + esc(k) + '">' + esc(label) + (value === undefined ? '' : ': <b>' + esc(value) + '</b>') + '</div>'; }
  function saveSources(cfg, focus, sub) { savePrefs({ sources: cfg }, function () { sourcesPage(sub, focus); }); }
  function sourcesPage(sub, focus) {
    ++browseToken;
    var c = Api.sourcesCfg(), h = '<div class="art-shade"></div>' + topbar('settings') + '<div class="vs" id="main" data-pad-top="140"><div class="settings">';
    if (sub === 'sites') {
      h += '<h1>Search these sites</h1><div class="hint">Leave "All sites" on to search everything (recommended). Choosing sites narrows the search to just those.</div>' +
        srow('srcallsites', 'all', 'All sites (recommended)', c.providers.length ? 'OFF' : 'ON');
      Sources.PROVIDERS.forEach(function (p) { h += srow('srcsite', p[0], p[1], c.providers.indexOf(p[0]) >= 0 ? 'ON' : 'OFF'); });
      h += srow('srcback', 'back', 'Back to Sources');
    } else {
      h += '<h1>Sources</h1><div class="hint">These choices are shared by everyone in the household. Camera recordings and screeners are always left out. Each title offers the 3 files with the most seeds in every resolution.</div>' +
        '<div class="lbl">Automatic playback</div>' + srow('quality', 'quality', 'Preferred quality', Api.quality() || 'Not chosen') +
        '<div class="lbl">Hide</div>';
      Sources.HIDE.forEach(function (x) { h += srow('srchide', x[0], x[1] + ' – ' + x[2], c.hide[x[0]] ? 'HIDDEN' : 'SHOWN'); });
      h += '<div class="lbl">Files</div>' + srow('srcsize', 'size', 'Largest file', c.maxGb ? 'Up to ' + c.maxGb + ' GB' : 'No limit') +
        srow('srclang', 'lang', 'Preferred audio language', Sources.langName(c.language)) +
        srow('srcsites', 'sites', 'Sites searched', c.providers.length ? c.providers.length + ' chosen' : 'All sites') +
        '<div class="lbl">Check it</div>' + srow('srctest', 'test', 'Test these settings with a sample film') + srow('srcreset', 'reset', 'Restore the default filters') +
        '<div class="lbl">Advanced</div><input id="srcurl" class="field f" data-k="custom" value="' + esc(c.custom) + '" placeholder="Custom source address (leave empty to use the built-in sources)">' +
        srow('srccustom', 'savecustom', 'Save the custom address') +
        '<div class="hint">Now: ' + esc(Sources.summary(c)) + '</div>';
    }
    h += '</div></div>';
    replaceAll('sources', h, { cls: 'noart', onBack: function () { if (sub) { sourcesPage(); return true; } page('settings'); return true; } });
    var f = focus && Nav.root().querySelector('[data-k="' + focus + '"]');
    Nav.set(f || Nav.root().querySelector('.srow'));
  }
  function testSources() {
    toast('Testing with a sample film …', 20000);
    Api.ensure().then(function () { return Api.getStreams('movie', 'tt0111161'); }).then(function (r) {
      var n = 0, parts = []; ['4K', '1080p', '720p', 'Other'].forEach(function (k) { if (r.counts[k]) { n += r.counts[k]; parts.push((k === 'Other' ? 'other' : k) + ' ' + r.counts[k]); } });
      toast(n ? n + ' files found for the sample film (' + parts.join(', ') + ')' : 'No files found with these settings. Try showing more, or check the connection.', 7000);
    }).catch(function (e) { toast('Could not check: ' + e.message, 7000); });
  }

  /* ---------- settings ---------- */
  var PLAY_MODES = { auto: 'Automatic: transcode only when the TV cannot play the file', direct: 'Always direct (never transcode)', transcode: 'Always transcode (if video stutters or will not play)' };
  var BUF_MODES = { auto: 'Automatic: waits only as long as the download speed needs', quick: 'Quick start: less waiting, more risk of stutter', safe: 'Safe: waits longer for a smoother start', off: 'Off: start playing as soon as possible' };
  function playMode() { var m = Store.get('playback', null); if (m === null) m = Store.get('transcode', false) ? 'transcode' : 'auto'; return m; }
  function subPrefs() { var p = Store.get('subs', null) || {}; return { lang: p.lang || 'eng', lang2: p.lang2 || '', auto: !!p.auto, autosync: !!p.autosync }; }
  function setSub(k, v) { var p = subPrefs(); p[k] = v; Store.set('subs', p); }
  function countryName(c) { for (var i = 0; i < Tmdb.COUNTRIES.length; i++) if (Tmdb.COUNTRIES[i][0] === c) return Tmdb.COUNTRIES[i][1]; return c; }
  function localeName(c) { for (var i = 0; i < Tmdb.LOCALES.length; i++) if (Tmdb.LOCALES[i][0] === c) return Tmdb.LOCALES[i][1]; return c; }
  function tmdbSettingsRows() {
    var h = '<div class="lbl">Artwork, ratings and cast (shared by the household)</div>';
    if (Tmdb.on()) {
      h += '<div class="srow f" data-act="tregion">Country (age ratings, cinema listings): <b>' + esc(countryName(Tmdb.region())) + '</b></div>' +
        '<div class="srow f" data-act="tlocale">Language of titles and summaries: <b>' + esc(localeName(Tmdb.locale())) + '</b></div>';
    }
    if (Tmdb.canKey()) h += '<input id="tmdbkey" class="field f" type="password" placeholder="' + (Tmdb.on() ? 'TMDB key saved. Paste a new one to replace it' : 'Paste the TMDB key to switch this on') + '" autocomplete="off"><div class="srow f" data-act="savetmdb">Save the TMDB key</div>';
    else if (Tmdb.source() === 'portal') h += '<div class="hint">The TMDB key is kept safely in Portal Admin (App keys).</div>';
    else if (!Tmdb.on()) h += '<div class="hint">Titles with logos, cast, age ratings, trending lists and Discover switch on when a JoolzApp admin adds a TMDB key here.</div>';
    return h + '<div class="hint">This product uses the TMDB API but is not endorsed or certified by TMDB. Where-to-watch data is provided by JustWatch.</div>';
  }
  function downloadsRows() {
    var h = '<div class="lbl">Downloads and cache</div>', js = Dl.jobs();
    h += '<div class="srow f" data-act="cachesize" id="cacherow">Streaming cache: <b>checking\u2026</b></div>';
    if (!js.length) h += '<div class="hint">Nothing downloaded ahead. Open a title and choose \u201cDownload ahead\u201d: it is fetched in the background and you are told here when it is ready.</div>';
    js.slice(0, 12).forEach(function (x) { h += '<div class="srow f" data-act="dljob" data-id="' + esc(x.id) + '">' + esc(Dl.title(x)) + ': <b>' + esc(Dl.state(x)) + '</b></div>'; });
    return h;
  }
  function fillCacheRow() {
    Backend.call('GET', '/api/server/cache').then(function (c) {
      var row = document.getElementById('cacherow'); if (!row) return;
      var gb = function (n) { return n === null || n === undefined ? 'unknown' : Number(n) === 0 ? 'none' : (Number(n) / 1073741824).toFixed(Number(n) % 1073741824 ? 1 : 0) + ' GB'; };
      row.innerHTML = 'Streaming cache: <b>' + esc(gb(c.reported)) + '</b>' + (c.ok ? '' : (c.tried ? ' (50 GB was asked for and the server did not take it)' : '')) + (c.freeBytes ? ' \u00b7 ' + esc(Dl.fmtBytes(c.freeBytes)) + ' free on the server' : '');
      row._cache = c;
    }).catch(function () { var row = document.getElementById('cacherow'); if (row) row.innerHTML = 'Streaming cache: <b>could not be read</b>'; });
  }
  var settingsTab = 'profile';
  function settingsPage(tab) {
    tab = typeof tab === 'string' ? tab : settingsTab; settingsTab = tab;
    ++browseToken;
    var pr = Profiles.active(), rep = Api.deviceReport();
    var rowsBy = {
      profile: '<div class="lbl">Profile – ' + esc(pr ? pr.name : '') + '</div>' +
      '<div class="srow f" data-act="members">Household: add, rename or remove profiles</div>' +
      '<div class="srow f" data-act="picker">Switch profile</div>' +
      '<div class="srow f" data-act="qaset">Quick Access (PIN or pattern) on this TV: <b>' + (qaGet(Store.active()) ? ({ pin4: '4 digit PIN', pin6: '6 digit PIN', pattern: 'Pattern' })[qaGet(Store.active()).kind] : 'Off') + '</b></div>' +
      '<div class="srow f" data-act="theme">Appearance: <b>' + ({ dark: 'Dark', light: 'Light', auto: 'Auto (light from sunrise to sunset)' })[Theme.mode()] + '</b></div>' +
      '<div class="srow f" data-act="signout">Sign out of this profile on this TV</div>',
      sources: '<div class="lbl">Sources (the whole household)</div>' +
      '<div class="srow f" data-act="quality">Preferred quality for automatic playback: <b>' + esc(Api.quality() || 'Not chosen') + '</b></div>' +
      '<div class="srow f" data-act="sourcespage">Sources and filters: <b>' + esc(Sources.summary(Api.sourcesCfg())) + '</b></div>' +
      tmdbSettingsRows(),
      subtitles: '<div class="lbl">Subtitles</div>' +
      '<div class="srow f" data-act="sublang">Show subtitles in: <b>' + esc(Subs.langName(subPrefs().lang)) + '</b> (other languages are hidden)</div>' +
      '<div class="srow f" data-act="sublang2">Second language: <b>' + esc(subPrefs().lang2 ? Subs.langName(subPrefs().lang2) : 'None') + '</b></div>' +
      '<div class="srow f" data-act="subauto">Turn on the best matching subtitles automatically: <b>' + (subPrefs().auto ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="srow f" data-act="subautosync">Auto-sync subtitles when they are turned on (uses your server\'s processor): <b>' + (subPrefs().autosync ? 'ON' : 'OFF') + '</b></div>',
      playback: '<div class="lbl">Playback</div>' +
      '<div class="srow f" data-act="playmode">Playback mode: <b>' + esc(PLAY_MODES[playMode()]) + '</b></div>' +
      '<div class="srow f" data-act="bufmode">Start-up buffering: <b>' + esc(BUF_MODES[Store.get('bufmode', 'auto')]) + '</b></div>' +
      '<div class="srow f" data-act="redodc">Run the device check again (tests which formats this device plays)</div>' +
      '<div class="srow f" data-act="forgetdev">Forget what this device can play: <b>' + (rep.good.length + rep.bad.length) + ' formats remembered</b></div>' +
      '<div class="hint">' + (rep.good.length ? 'Plays directly: ' + esc(rep.good.join(', ')) + '. ' : '') + (rep.bad.length ? 'Needs transcoding: ' + esc(rep.bad.join(', ')) + '. ' : '') + (rep.good.length + rep.bad.length ? '' : 'JoolzTV learns what this device can decode as you watch, so the next file of that kind starts the right way straight away.') + '</div>',
      downloads: downloadsRows(),
      kids: '<div class="lbl">Kids (parents only)</div><div class="srow f" data-act="klimit" data-id="all" id="kall">All kids screen time: <b>\u2026</b></div>' +
        '<div class="srow f" data-act="khidden" id="khid">Hidden from kids: <b>\u2026</b></div>' +
        '<div class="hint">A kid\u2019s own screen time (on the Kids tab) wins over All kids. Hidden titles disappear for every kids profile and can only be shown again here.</div>',
      more: '<div class="lbl">Typing</div>' +
      '<div class="srow f" data-act="kbdmode">On-screen keyboard: <b>' + (Kbd.enabled() ? 'Big keys' : 'The TV\u2019s own keyboard') + '</b></div>' +
      '<div class="hint">JoolzTV ' + esc(window.FLIX_VERSION || '') + '. The top 3 sources by seeds are offered per resolution; posters come from Cinemeta and subtitles from OpenSubtitles. Video plays through your own streaming server behind your JoolzApp sign-in. You stay signed in while anyone in the household uses JoolzTV; after 90 days with no use everyone signs in again. ' + esc(Sync.status()) + '</div></div></div>',
    };
    var STABS = [['profile', 'Profile'], ['sources', 'Sources'], ['subtitles', 'Subtitles'], ['playback', 'Playback'], ['downloads', 'Downloads']].concat(isParent() ? [['kids', 'Kids']] : [], [['more', 'Typing and about']]), tabsH = '<div class="seasons" id="stabs">';
    STABS.forEach(function (t) { tabsH += '<span class="chip f' + (t[0] === tab ? ' on' : '') + '" data-act="stab" data-t="' + t[0] + '">' + t[1] + '</span>'; });
    tabsH += '</div>';
    var h = '<div class="art-shade"></div>' + topbar('settings') + '<div class="vs" id="main" data-pad-top="140"><div class="settings"><h1>Settings</h1>' + tabsH + (rowsBy[tab] || rowsBy.profile) + '</div></div>';
    replaceAll('settings', h, { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
    if (tab === 'kids') fillKidsSettings();
    if (tab === 'downloads') { fillCacheRow(); Dl.refresh().then(function () { var v = current(); if (v && v.name === 'settings' && settingsTab === 'downloads' && document.querySelectorAll('[data-act=dljob]').length !== Math.min(12, Dl.jobs().length)) settingsPage(); }); }
  }

  /* ---------- actions ---------- */
  function act(el) {
    var a = el.getAttribute('data-act');
    if (a === 'page') return page(el.getAttribute('data-p'));
    if (a === 'open') { var m = reg[+el.getAttribute('data-k')]; if (!m.id && m.tmdb) return openTmdb(m); return detail(m.type, m.id, m); }
    if (a === 'play') return playChecked(reg[+el.getAttribute('data-k')]);
    if (a === 'notify') { var ni = reg[+el.getAttribute('data-k')], nel = current().el, nv = null; ((nel && nel._detail && nel._detail.S.by[+String(ni.sub || '').replace(/^S(\d+).*/, '$1')]) || []).forEach(function (x) { if (x.id === ni.videoId) nv = x; }); return nv && notifyCycle(nv, ni); }
    if (a === 'season') return renderEpisodes(current().el, +el.getAttribute('data-s'));
    if (a === 'speak') return speak();
    if (a === 'cachesize') { var cc = el._cache; if (!cc) return; if (!cc.canSet) return toast('Only a JoolzApp admin can change the cache size', 4000);
      return menu('Streaming cache size', cc.choices.map(function (g) { return { label: g + ' GB', g: g, selected: Math.round(Number(cc.reported) / 1073741824) === g }; }), function (o) {
        Backend.call('PUT', '/api/server/cache', { gb: o.g }).then(function () { toast('Cache set to ' + o.g + ' GB', 3500); settingsPage(); }).catch(function (e) { toast(e.message, 8000); });
      }, 'A cache is a ceiling, not a reserved space: the oldest films are dropped when it is full. Make sure the server has that much free disk.'); }
    if (a === 'dljob') { var jb = null, jid = el.getAttribute('data-id'); Dl.jobs().forEach(function (x) { if (x.id === jid) jb = x; }); if (!jb) return;
      return menu(Dl.title(jb), [{ label: 'Open the title', k: 'o' }, { label: jb.status === 'ready' || jb.status === 'failed' ? 'Remove from the list' : 'Cancel this download', k: 'x' }], function (o) { if (o.k === 'o') return detail(jb.type, jb.imdb, { name: jb.name, poster: jb.poster }); Dl.remove(jb.id).then(function () { settingsPage(); }); }, Dl.state(jb)); }
    if (a === 'stab') return settingsPage(el.getAttribute('data-t'));
    if (a === 'detailback') return back();
    if (a === 'dlahead') return dlAhead(current().el);
    if (a === 'netflix') return launchNetflix(el.getAttribute('data-title'));
    if (a === 'xtab') return xTab(current().el, el.getAttribute('data-t'));
    if (a === 'person') return personPage(el.getAttribute('data-id'));
    if (a === 'collection') return collectionPage(el.getAttribute('data-id'));
    if (a === 'dtype' || a === 'dsort' || a === 'dyear' || a === 'dgenre') return discoverMenu(a);
    if (a === 'recent') { var rq = el.getAttribute('data-q') || '', qi = document.getElementById('q'); if (qi) { qi.value = rq; LASTQ = rq; qi.dispatchEvent(new Event('change')); } return; }
    if (a === 'recentdel') { Recent.del(el.getAttribute('data-q') || ''); recentPaint(); Nav.first('#q'); return; }
    if (a === 'dmore') { DISC.page++; var mh = document.getElementById('gmoreh'); if (mh) mh.innerHTML = ''; return discoverLoad(); }
    if (a === 'pick') { var mm = menuEl, i = +el.getAttribute('data-i'), cb = mm._pick, o = mm._opts[i]; closeMenu(); return cb(o, i); }
    if (a === 'toggle') return el.classList.toggle('on');
    if (a === 'kkey') return Kbd.press(el);
    if (a === 'kshow') return Kbd.toggleShow();
    if (a === 'kbdmode') { Store.set('kbd', Kbd.enabled() ? 'system' : 'big'); return settingsPage(); }
    if (a === 'avatarmenu') return menu('Profile', [{ label: 'Switch profile', k: 'picker' }, { label: 'Settings', k: 'settings' }, { label: 'Sign out of this profile on this TV', k: 'signout' }], function (o) {
      if (o.k === 'picker') picker(); else if (o.k === 'settings') page('settings'); else doSignOut();
    });
    if (a === 'retryboot') return window.JTVBoot && JTVBoot();
    if (a === 'wizardgo') return wizardGo();
    if (a === 'devicego') return deviceGo();
    if (a === 'qrwizard') return qrWizard();
    if (a === 'qrdevice') return qrDevice();
    if (a === 'qrmember') return qrMember();
    if (a === 'qrsignin') return qrSignin(Profiles.get(el.getAttribute('data-id')));
    if (a === 'qrback') return window.__qrBack && window.__qrBack();
    if (a === 'selprofile') return selectProfile(el.getAttribute('data-id'));
    if (a === 'signingo') return signinGo(el.getAttribute('data-id'));
    if (a === 'picker') return picker();
    if (a === 'forgot') { var em = val('em'); if (!em) return ferr('Enter your email first.'); return Backend.call('POST', '/api/account/forgot', { email: em }, null).then(function (r) { ferr(r.message); }).catch(function (e) { ferr(e.message); }); }
    if (a === 'members') return members(false);
    if (a === 'membersdone') return Profiles.active() ? page('home') : picker();
    if (a === 'membersback') return members(false);
    if (a === 'addmember') return addMember();
    if (a === 'addmembergo') return addMemberGo();
    if (a === 'editprofile') return editProfile(el.getAttribute('data-id'));
    if (a === 'pickavatar') return avatarPage(el.getAttribute('data-id'));
    if (a === 'setavatar') return setAvatar(el.getAttribute('data-id'), el.getAttribute('data-v'));
    if (a === 'saveprofile') return saveProfile(el.getAttribute('data-id'));
    if (a === 'delprofile') return delProfile(el.getAttribute('data-id'));
    if (a === 'signout') return doSignOut();
    if (a === 'togglecol') {
      var ce = current().el._col; if (!ce) return;
      var cyes = !MyList.has(ce.id); MyList.set(ce, cyes);
      var cb = current().el.querySelector('#colbtn'); if (cb) cb.textContent = cyes ? '\u2713  In My List' : '+  My List';
      return toast(cyes ? 'Collection added to My List' : 'Collection removed from My List');
    }
    if (a === 'togglelib') {
      var dv = current().el._detail; if (!dv) return;
      var yes = !MyList.has(dv.id);
      MyList.set({ id: dv.id, name: dv.m.name, type: dv.type, poster: dv.m.poster }, yes);
      var bb = current().el.querySelector('#libbtn'); if (bb) bb.textContent = yes ? '✓  In My List' : '+  My List';
      return toast(yes ? 'Added to My List' : 'Removed from My List');
    }
    if (a === 'qaset') return qaMenu(Store.active(), function () { settingsPage(); });
    if (a === 'qasignin') return qaSignin(el.getAttribute('data-id'));
    if (a === 'padk') { if (el.hasAttribute('data-i')) return padDot(+el.getAttribute('data-i')); var k = el.getAttribute('data-k'); if (k === '\u232b') { if (Pad && Pad.code.length) { Pad.code = Pad.code.slice(0, -1); padPaint(); } return; } return padAdd(k); }
    if (a === 'paddone') return padDone();
    if (a === 'padclear') { if (Pad) { Pad.seq = []; padPaint(); ferr(''); } return; }
    if (a === 'padback') { var pb = Pad && Pad.onBack; Pad = null; return pb && pb(); }
    if (a === 'padpass') { Pad = null; return signin(Profiles.get(el.getAttribute('data-id'))); }
    if (a === 'theme') return menu('Appearance', [{ label: 'Dark', m: 'dark' }, { label: 'Light', m: 'light' }, { label: 'Auto  –  light from sunrise to sunset where you are', m: 'auto' }].map(function (o) { o.selected = o.m === Theme.mode(); return o; }), function (o) { Theme.set(o.m); settingsPage(); });
    if (a === 'quality') return menu('Preferred quality', QUALITY_INFO.map(function (q) { return { label: q[0] + '  –  ' + q[1], q: q[0], selected: q[0] === Api.quality() }; }), function (o) { savePrefs({ quality: o.q }, function () { if (current() && current().name === 'sources') sourcesPage(null, 'quality'); else settingsPage(); }); });
    if (a === 'setquality') { var qq = el.getAttribute('data-q'); return savePrefs({ quality: qq }, function () { var cb = window._qcont; window._qcont = null; if (cb) cb(); }); }
    if (a === 'sourcespage') return sourcesPage();
    if (a === 'srchide') { var hk = el.getAttribute('data-k'), c1 = Api.sourcesCfg(); c1.hide[hk] = !c1.hide[hk]; return saveSources(c1, hk); }
    if (a === 'srcsize') { var c2 = Api.sourcesCfg(); return menu('Largest file', Sources.SIZES.map(function (g) { return { label: g ? 'Up to ' + g + ' GB' : 'No limit', g: g, selected: g === c2.maxGb }; }), function (o) { c2.maxGb = o.g; saveSources(c2, 'size'); }); }
    if (a === 'srclang') { var c3 = Api.sourcesCfg(); return menu('Preferred audio language', Sources.LANGS.map(function (l) { return { label: l[1], code: l[0], selected: l[0] === c3.language }; }), function (o) { c3.language = o.code; saveSources(c3, 'lang'); }); }
    if (a === 'srcsites') return sourcesPage('sites');
    if (a === 'srcsite') { var c4 = Api.sourcesCfg(), id4 = el.getAttribute('data-k'), i4 = c4.providers.indexOf(id4); if (i4 >= 0) c4.providers.splice(i4, 1); else c4.providers.push(id4); return saveSources(c4, id4, 'sites'); }
    if (a === 'srcallsites') { var c5 = Api.sourcesCfg(); c5.providers = []; return saveSources(c5, 'all', 'sites'); }
    if (a === 'srcback') return sourcesPage();
    if (a === 'srccustom') { var c6 = Api.sourcesCfg(), cv = val('srcurl'); if (cv && !/^https:\/\//.test(cv)) return toast('The address must start with https://'); c6.custom = cv; return saveSources(c6, 'custom'); }
    if (a === 'srcreset') { return savePrefs({ sources: Sources.defaults() }, function () { toast('Source filters restored'); sourcesPage(); }); }
    if (a === 'srctest') return testSources();
    if (a === 'tregion') return menu('Country', Tmdb.COUNTRIES.map(function (c) { return { label: c[1], c: c[0], selected: c[0] === Tmdb.region() }; }), function (o) { savePrefs({ region: o.c }, function () { settingsPage(); }); });
    if (a === 'tlocale') return menu('Language of titles and summaries', Tmdb.LOCALES.map(function (c) { return { label: c[1], c: c[0], selected: c[0] === Tmdb.locale() }; }), function (o) { savePrefs({ locale: o.c }, function () { settingsPage(); }); });
    if (a === 'savetmdb') { var tk = val('tmdbkey'); if (!tk) return toast('Paste the TMDB key first'); return Tmdb.setKey(tk).then(function (j) { toast(j.enabled ? 'TMDB is on' : 'TMDB is off', 4000); settingsPage(); }).catch(function (e) { toast(e.message, 6000); }); }
    if (a === 'kidflag') { var kp = Profiles.get(el.getAttribute('data-id')); return patchKid(kp.id, { kid: !kp.kid }, kp.kid ? 'No longer a kids profile' : 'Marked as a kids profile'); }
    if (a === 'listmode') { var lp = Profiles.get(el.getAttribute('data-id')); return menu('Title list for ' + lp.name, [['off', 'Off'], ['block', 'Block the titles on the list'], ['allow', 'Only allow the titles on the list']].map(function (m) { return { label: m[1], m: m[0], selected: (lp.mode || 'off') === m[0] }; }), function (o) { patchKid(lp.id, { mode: o.m }, 'Saved'); }, 'With "Only allow", the profile\u2019s home shows just the listed titles and everything else is refused. Adult titles are blocked for everyone whatever the list says.'); }
    if (a === 'titles') return titlesPage(el.getAttribute('data-id'));
    if (a === 'addtitle') { var tm = reg[+el.getAttribute('data-k')]; return listEdit(el.getAttribute('data-id'), { add: [tm] }, 'Added ' + tm.name); }
    if (a === 'rmtitle') return listEdit(el.getAttribute('data-id'), { remove: [el.getAttribute('data-imdb')] }, 'Removed');
    if (a === 'ktile') return kidTitleMenu(+el.getAttribute('data-i'));
    if (a === 'klimit') return kidLimitMenu(el.getAttribute('data-id'));
    if (a === 'kmore') return giveMoreTime(el.getAttribute('data-id'));
    if (a === 'khidden') return hiddenMenu();
    if (a === 'askparent') return askParent();
    if (a === 'kidsmenu') { var dv = current().el._detail; return kidsMenu(dv.type, dv.id, dv.m); }
    if (a === 'agelimit') { var pid = el.getAttribute('data-id'); return menu('Age limit for this profile', [{ label: 'No limit', v: null }, { label: 'Up to age 7', v: 7 }, { label: 'Up to age 10', v: 10 }, { label: 'Up to age 13', v: 13 }, { label: 'Up to age 16', v: 16 }], function (o) {
      Backend.setMaxAge(pid, o.v).then(function (r) { Profiles.setAll(Profiles.all().map(function (x) { if (x.id === pid) x.maxAge = r.profile.maxAge; return x; })); toast(o.v === null ? 'Age limit removed' : 'Age limit set', 3000); editProfile(pid); }).catch(function (e) { toast(e.message, 5000); }); }, 'Titles rated above this age are hidden and will not play on this profile. Accounts that JoolzApp knows are under 18 are limited to their own age automatically.'); }
    if (a === 'playmode') { var order = ['auto', 'direct', 'transcode']; Store.set('playback', order[(order.indexOf(playMode()) + 1) % 3]); return settingsPage(); }
    if (a === 'skipdc') { DeviceTest.skip(); return window._dcLeave && window._dcLeave(); }
    if (a === 'dcdone') return window._dcLeave && window._dcLeave();
    if (a === 'redodc') { DeviceTest.reset(); return deviceCheck(function () { page('settings'); }); }
    if (a === 'bufmode') { var bo = ['auto', 'quick', 'safe', 'off']; Store.set('bufmode', bo[(bo.indexOf(Store.get('bufmode', 'auto')) + 1) % 4]); return settingsPage(); }
    if (a === 'forgetdev') { Api.forgetDevice(); toast('Forgot what this device can play'); return settingsPage(); }
    if (a === 'subauto') { setSub('auto', !subPrefs().auto); return settingsPage(); }
    if (a === 'subautosync') { setSub('autosync', !subPrefs().autosync); return settingsPage(); }
    if (a === 'sublang' || a === 'sublang2') {
      var two = a === 'sublang2', cur = two ? subPrefs().lang2 : subPrefs().lang, ls = (two ? [['', 'None']] : []).concat(Subs.LANGS);
      return menu(two ? 'Second subtitle language' : 'Subtitle language', ls.map(function (l) { return { label: l[1], code: l[0], selected: l[0] === cur }; }), function (o) { setSub(two ? 'lang2' : 'lang', o.code); settingsPage(); });
    }
  }
  function doSignOut() { var id = Store.active(); if (id) { Store.delFor(id, 'token'); } Backend.setToken(null); Store.setActive(null); picker(); }
  function back() {
    if (Kbd.close()) return true;
    if (closeMenu()) return true;
    var v = current();
    if (v && v.onBack && v.onBack() === true) return true;
    return pop();
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (el && Nav.root().contains(el)) act(el);
  });

  return { padKey: padKey, splash: splash, offline: offline, wizard: wizard, deviceSignin: deviceSignin, picker: picker, signedOut: signedOut, detail: detail, page: page, mount: mount, pop: pop, back: back,
           menu: menu, closeMenu: closeMenu, toast: toast, timesUp: timesUp, esc: esc, fmtTime: fmtTime, act: act, runSearch: runSearch, current: current, hasMenu: function () { return !!menuEl; } };
})();
