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
    set: function (m, yes) { var a = all(); a[m.id] = { type: m.type, id: m.id, name: m.name, poster: m.poster, ts: Date.now(), removed: !yes }; Store.set('list', a); },
    items: function () { var a = all(); return Object.keys(a).map(function (k) { return a[k]; }).filter(function (e) { return !e.removed; }).sort(function (x, y) { return y.ts - x.ts; }); }
  };
})();

var Views = (function () {
  var app = document.getElementById('app'), stack = [], reg = [], seq = 0, menuEl = null, menuPrev = null, toastT = null, browseToken = 0, infoT = null;
  var TABS = [['home', 'Home'], ['movie', 'Movies'], ['series', 'TV Shows'], ['library', 'My List'], ['search', 'Search']];
  var PAGES = ['home', 'movie', 'series', 'library', 'search', 'settings'];

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
    var pr = Profiles.active(), h = '<div class="top"><div class="brand">Joolz<b>TV</b></div><div class="tabbar glass">';
    TABS.forEach(function (t) { h += '<div class="tab f' + (t[0] === active ? ' on' : '') + '" data-act="page" data-p="' + t[0] + '">' + t[1] + '</div>'; });
    h += '</div>';
    if (pr) h += '<div class="who glass f" data-act="avatarmenu"><span class="av" style="background:' + esc(pr.color) + '">' + initial(pr.name) + '</span>' + esc(pr.name) + '</div>';
    return h + '</div>';
  }
  function card(m, extra) {
    var k = ref(m), bar = '';
    if (extra && extra.pct != null) bar = '<div class="barbg"></div><div class="bar" style="width:' + Math.round(extra.pct * 206) + 'px"></div>';
    return '<div class="card f" data-act="open" data-k="' + k + '"><div class="img" data-bg="' + esc(m.poster || '') + '"></div>' + bar + '</div>';
  }
  function rowHtml(title, metas, extraFn) {
    var h = '<div class="row"><h2>' + esc(title) + '</h2><div class="hs">';
    metas.slice(0, 20).forEach(function (m) { h += card(m, extraFn ? extraFn(m) : null); });
    return h + '<span class="pad-end"></span></div></div>';
  }
  function setArt(el, url) { var a = el && el.querySelector('.art'); if (!a) return; if (url) { a.style.backgroundImage = 'url("' + url + '")'; el.classList.remove('noart'); } }
  function showInfo(m) {
    var el = document.getElementById('info'); if (!el || !m) return;
    var r = m._resume ? '<div class="chips"><span class="chip">Resume at ' + esc(fmtTime(m._resume.t)) + '</span></div>' : '<div class="chips">' + meta1(m) + '</div>';
    el.innerHTML = '<h1>' + esc(m.name) + '</h1>' + r + '<div class="desc">' + esc(m.description || '') + '</div>';
    var v = current(); if (v) setArt(v.el, m.background || m.poster);
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
      toggleHtml('keep', 'Stay signed in on this TV (90 days)', true) + '<div class="btn primary f" data-act="wizardgo">Sign in and continue</div>', null);
  }
  function wizardGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.addProfile(em, pw, '', null).then(function (r) {
      Profiles.setAll(r.profiles); finishSignIn(r.profile.id, em, r.token, isOn('keep'));
      Backend.setToken(r.token); deviceCheck(function () { members(true); });
    }).catch(function (e) { ferr(e.message); });
  }
  /* a new device for an existing household: sign in with any member's account, the household comes down with it */
  function deviceSignin() {
    formView('devicesignin', 'Sign in to JoolzTV', 'Sign in with your JoolzApp account to use this household on this TV.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Password">' +
      toggleHtml('keep', 'Stay signed in on this TV (90 days)', true) + '<div class="btn primary f" data-act="devicego">Sign in</div>', null);
  }
  function deviceGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.login(em, pw).then(function (r) {
      return Backend.household(r.token).then(function (h) {
        var me = h.profiles.filter(function (p) { return p.self; })[0];
        if (!me) throw new Error('That account is not part of this household.');
        Profiles.setAll(h.profiles); finishSignIn(me.id, em, r.token, isOn('keep')); enter(me.id);
      });
    }).catch(function (e) { ferr(e.message); });
  }
  function finishSignIn(id, email, token, keep) {
    Store.setFor(id, 'email', email); Store.setFor(id, 'remember', !!keep);
    if (keep) Store.setFor(id, 'token', token); else Store.delFor(id, 'token');
    Profiles.setActive(id);
  }

  /* "Who's watching?" */
  function picker() {
    ++browseToken;
    var ps = Profiles.all(), h = '<div class="splash"><div class="picker"><h1>Who\'s watching?</h1><div class="ptiles">';
    ps.forEach(function (p) {
      h += '<div class="ptile f" data-act="selprofile" data-id="' + esc(p.id) + '"><div class="pav" style="background:' + esc(p.color) + '">' + initial(p.name) + '</div><div class="pn">' + esc(p.name) + '</div>' +
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
  function signin(p, msg) {
    var em = Store.getFor(p.id, 'email', '');
    formView('signin', 'Hi ' + p.name, 'Sign in with your JoolzApp account to continue.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off" value="' + esc(em) + '"><input id="pw" class="field f" type="password" placeholder="Password">' +
      toggleHtml('keep', 'Stay signed in on this TV (90 days)', Store.getFor(p.id, 'remember', true) !== false) +
      '<div class="btn primary f" data-act="signingo" data-id="' + esc(p.id) + '">Sign in</div><div class="btn glass f" data-act="forgot">Forgot password</div><div class="btn glass f" data-act="picker">Back</div>',
      function () { picker(); return true; });
    if (msg) ferr(msg);
    if (em) Nav.set(document.getElementById('pw'));
  }
  function signinGo(id) {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.login(em, pw).then(function (r) {
      return Backend.household(r.token).then(function (h) {
        var me = h.profiles.filter(function (p) { return p.self; })[0];
        if (!me || me.id !== id) throw new Error('That account belongs to a different profile. Pick that profile instead.');
        Profiles.setAll(h.profiles); finishSignIn(id, em, r.token, isOn('keep')); enter(id, r.token);
      });
    }).catch(function (e) { ferr(e.message); });
  }
  function enter(id, token) {
    if (!DeviceTest.done()) { Store.setActive(id); if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token()); return deviceCheck(function () { enter(id, token); }); }
    Store.setActive(id);
    if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token());
    Api.setStreamBase('');
    Backend.household().then(function (h) { Profiles.setAll(h.profiles); }).catch(function () {});
    Sync.run(function () { var v = current(); if (v && PAGES.indexOf(v.name) >= 0 && v.name === 'home') page('home'); });
    page('home');
  }
  function signedOut() {                       // the server said 401: this profile must sign in again
    var id = Store.active(), p = id && Profiles.get(id);
    Backend.setToken(null); if (id) Store.delFor(id, 'token'); Store.setActive(null);
    if (p) signin(p, 'Your sign-in expired. Please sign in again.'); else picker();
  }

  /* household management (after the wizard, or from Settings): add members, rename, remove, stay-signed-in per profile */
  function members(firstRun) {
    ++browseToken;
    var ps = Profiles.all(), h = '<div class="splash"><div class="picker"><h1>' + (firstRun ? 'Who else watches?' : 'Household') + '</h1><div class="ptiles">';
    ps.forEach(function (p) {
      h += '<div class="ptile f" data-act="editprofile" data-id="' + esc(p.id) + '"><div class="pav edit" style="background:' + esc(p.color) + '">' + initial(p.name) + '</div><div class="pen">✎</div><div class="pn">' + esc(p.name) + '</div>' +
        '<div class="ps">' + (Store.getFor(p.id, 'token', null) ? 'Signed in on this TV' : 'Not signed in here') + '</div></div>';
    });
    if (ps.length < Profiles.max()) h += '<div class="ptile f" data-act="addmember"><div class="pav add">+</div><div class="pn">Add member</div></div>';
    h += '</div><div class="btn primary f pbtn2" data-act="membersdone">Done</div></div></div>';
    replaceAll('members', h, { onBack: function () { page('home'); return true; } });
    Nav.set(Nav.root().querySelector('.ptile'));
  }
  function addMember() {
    formView('addmember', 'Add a household member', 'Each profile is one JoolzApp account. Enter that person\'s JoolzApp email and password. Turn on "Stay signed in" so they don\'t have to sign in each time on this TV.',
      '<input id="em" class="field f" type="email" placeholder="Their JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Their password">' +
      toggleHtml('keep', 'Stay signed in on this TV (90 days)', true) + '<div class="btn primary f" data-act="addmembergo">Add to household</div><div class="btn glass f" data-act="membersback">Cancel</div>',
      function () { members(false); return true; });
  }
  function addMemberGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter their JoolzApp email and password.');
    ferr('Adding…');
    Backend.addProfile(em, pw, '', Backend.token()).then(function (r) {
      Profiles.setAll(r.profiles); Store.setFor(r.profile.id, 'email', em); Store.setFor(r.profile.id, 'remember', isOn('keep'));
      if (isOn('keep')) Store.setFor(r.profile.id, 'token', r.token); else Store.delFor(r.profile.id, 'token');
      toast(r.profile.name + ' added'); members(false);
    }).catch(function (e) { ferr(e.message); });
  }
  function editProfile(id) {
    var p = Profiles.get(id); if (!p) return;
    var h = '<div class="center"><div class="form glass"><h1>' + esc(p.name) + '</h1><div class="sub">' + (p.owner ? 'Household owner' : 'Household member') + '</div><div class="err" id="ferr"></div>' +
      '<input id="nm" class="field f" maxlength="16" placeholder="Name" autocomplete="off" value="' + esc(p.name) + '">' +
      toggleHtml('keep', 'Stay signed in on this TV', !!Store.getFor(id, 'token', null)) +
      '<div class="btn primary f" data-act="saveprofile" data-id="' + esc(id) + '">Save</div>' +
      (Profiles.all().length > 1 ? '<div class="btn glass f" data-act="delprofile" data-id="' + esc(id) + '">Remove from household</div>' : '') +
      '<div class="btn glass f" data-act="membersback">Back</div></div></div>';
    replaceAll('editprofile', '<div class="splash">' + h + '</div>', { onBack: function () { members(false); return true; } });
    Nav.first('.field');
  }
  function saveProfile(id) {
    var nm = val('nm'); if (!nm) return ferr('Enter a name.');
    Backend.renameProfile(id, nm).then(function (r) {
      Profiles.setAll(Profiles.all().map(function (p) { if (p.id === id) { p.name = r.profile.name; } return p; }));
      if (!isOn('keep')) Store.delFor(id, 'token');
      else if (!Store.getFor(id, 'token', null) && id === Store.active() && Backend.token()) Store.setFor(id, 'token', Backend.token());
      Store.setFor(id, 'remember', isOn('keep')); toast('Saved'); members(false);
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
    if (kind === 'search') return searchPage();
    if (kind === 'settings') return settingsPage();
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
    var main = el.querySelector('#main'), defs = Api.catalogDefs().filter(function (d) { return kind === 'home' || d.type === kind; }).slice(0, 10);
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
    defs.forEach(function () { var s = document.createElement('div'); rows.appendChild(s); slots.push(s); });
    var pending = defs.length;
    function done() { if (--pending === 0 && token === browseToken && !rows.querySelector('.row')) main.innerHTML = '<div class="empty">Nothing to show right now. Check your internet connection.</div>'; }
    defs.forEach(function (d, i) {
      Api.fetchCatalog(d).then(function (metas) {
        if (token !== browseToken || !metas.length) return;
        slots[i].innerHTML = rowHtml((d.name || d.id) + ' – ' + (d.type === 'movie' ? 'Movies' : 'TV Shows'), metas);
        Nav.hydrate(); focusFirst();
      }).catch(function () {}).then(done);
    });
    Nav.hydrate();
  }
  function buildLibrary(el, token) {
    var main = el.querySelector('#main'), items = MyList.items();
    if (!items.length) { main.innerHTML = '<div class="empty">Your list is empty. Open any title and choose “+ My List”.</div>'; return; }
    var h = '<div class="grid">';
    items.slice(0, 150).forEach(function (i) { h += card({ type: i.type, id: i.id, name: i.name, poster: i.poster }); });
    main.innerHTML = h + '</div>'; Nav.hydrate();
  }

  /* ---------- search ---------- */
  function searchPage() {
    ++browseToken;
    replaceAll('search', '<div class="art img"></div><div class="art-shade"></div>' + topbar('search') + '<div class="vs" id="main"><div class="grid" style="padding-top:150px"><input id="q" class="field f" style="width:1100px" placeholder="Search movies and TV shows" autocomplete="off"><div id="res"></div></div></div>',
      { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('#q');
  }
  function runSearch(q) {
    var res = document.getElementById('res'); if (!res || !q) return;
    res.innerHTML = '<div class="skel">Searching…</div>';
    Api.ensure().then(function () { return Api.search(q); }).then(function (metas) {
      if (!document.getElementById('res')) return;
      if (!metas.length) { res.innerHTML = '<div class="skel">No results for “' + esc(q) + '”.</div>'; return; }
      var h = ''; metas.slice(0, 48).forEach(function (m) { h += card(m); });
      res.innerHTML = h; Nav.hydrate();
    }).catch(function (e) { res.innerHTML = '<div class="skel">Search failed: ' + esc(e.message) + '</div>'; });
  }

  /* ---------- title page ---------- */
  function detail(type, id, seed) {
    var el = mount('detail', '<div class="art img"></div><div class="art-shade"></div><div class="dtop"><h1>' + esc(seed && seed.name || '') + '</h1><div class="chips"><span class="chip">Loading…</span></div></div>', { cls: 'noart' });
    setArt(el, seed && (seed.background || seed.poster));
    Nav.hydrate();
    Api.ensure().then(function () { return Api.getMeta(type, id); }).then(function (m) {
      if (current().el !== el) return;
      renderDetail(el, type, id, m);
    }).catch(function (e) {
      var d = el.querySelector('.dtop'); if (d) d.innerHTML = '<h1>' + esc(seed && seed.name || '') + '</h1><div class="chips"><span class="chip">Could not load details: ' + esc(e.message) + '</span></div>';
    });
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
        var n = flat[q + 1]; if (n.season === 0 && flat[q].season > 0) return null;
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
        else { for (var i = 0; i < flat.length; i++) if (flat[i].id === last.videoId && flat[i + 1]) { playVid = flat[i + 1].id; sub = 'S' + flat[i + 1].season + ':E' + flat[i + 1].episode; season = flat[i + 1].season; } }
      }
    } else if (last && !last.done) { start = last.t; playLabel = '▶  Resume'; }
    var info = Object.assign({}, baseInfo, { videoId: playVid, startMs: start });
    if (isSeries) info.sub = sub;
    var k = ref(info), k2 = ref(Object.assign({}, info, { pick: true }));
    var h = '<h1>' + esc(m.name) + '</h1><div class="chips">' + meta1(m) + '</div><div class="desc">' + esc(m.description || '') + '</div>' +
      '<div class="btns"><div class="btn primary f" data-act="play" data-k="' + k + '">' + playLabel + (isSeries && sub ? '  ' + sub : '') + '</div>' +
      '<div class="btn glass f" data-act="play" data-k="' + k2 + '">Choose source</div>' +
      '<div class="btn glass f" data-act="togglelib" id="libbtn">' + (MyList.has(id) ? '✓  In My List' : '+  My List') + '</div></div>';
    el.querySelector('.dtop').innerHTML = h;
    el._detail = { type: type, id: id, m: m, S: S, base: baseInfo };
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
  }
  function renderEpisodes(el, season) {
    var D = el._detail, list = el.querySelector('#eplist'), eps = D.S.by[season] || [], h = '';
    eps.forEach(function (v) {
      var r = Resume.get(v.id), pct = r && r.d ? Math.min(1, r.t / r.d) : 0;
      var info = Object.assign({}, D.base, { videoId: v.id, startMs: r && !r.done ? r.t : 0, sub: 'S' + v.season + ':E' + v.episode, epTitle: v.title || v.name });
      h += '<div class="ep glass f" data-act="play" data-k="' + ref(info) + '"><div class="img" data-bg="' + esc(v.thumbnail || D.m.background || '') + '"></div>' +
        '<div class="t">' + (v.episode || v.number || '') + '. ' + esc(v.title || v.name || 'Episode') + '</div><div class="o">' + esc(v.overview || v.description || '') + '</div>' +
        (pct > 0.02 ? '<div class="bar" style="width:' + Math.round(pct * 440) + 'px"></div>' : '') + '</div>';
    });
    list.scrollLeft = 0;
    list.innerHTML = (h || '<div class="skel">No episodes.</div>') + '<span class="pad-end"></span>';
    Array.prototype.forEach.call(el.querySelectorAll('.chip[data-s]'), function (c) { c.classList.toggle('on', Number(c.getAttribute('data-s')) === Number(season)); });
    Nav.hydrate();
  }

  /* ---------- settings ---------- */
  var PLAY_MODES = { auto: 'Automatic: transcode only when the TV cannot play the file', direct: 'Always direct (never transcode)', transcode: 'Always transcode (if video stutters or will not play)' };
  var BUF_MODES = { auto: 'Automatic: waits only as long as the download speed needs', quick: 'Quick start: less waiting, more risk of stutter', safe: 'Safe: waits longer for a smoother start', off: 'Off: start playing as soon as possible' };
  function playMode() { var m = Store.get('playback', null); if (m === null) m = Store.get('transcode', false) ? 'transcode' : 'auto'; return m; }
  function subPrefs() { var p = Store.get('subs', null) || {}; return { lang: p.lang || 'eng', lang2: p.lang2 || '', auto: !!p.auto, autosync: !!p.autosync }; }
  function setSub(k, v) { var p = subPrefs(); p[k] = v; Store.set('subs', p); }
  function settingsPage() {
    ++browseToken;
    var pr = Profiles.active(), keep = !!Store.get('token', null), rep = Api.deviceReport();
    var h = '<div class="art-shade"></div>' + topbar('settings') + '<div class="vs" id="main" data-pad-top="140"><div class="settings"><h1>Settings</h1>' +
      '<div class="lbl">Profile – ' + esc(pr ? pr.name : '') + '</div>' +
      '<div class="srow f" data-act="members">Household: add, rename or remove profiles</div>' +
      '<div class="srow f" data-act="togglekeep">Stay signed in on this TV (90 days): <b>' + (keep ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="srow f" data-act="picker">Switch profile</div>' +
      '<div class="srow f" data-act="signout">Sign out of this profile on this TV</div>' +
      '<div class="lbl">Sources (Torrentio)</div>' +
      '<input id="tio" class="field f" value="' + esc(Api.torrentioUrl()) + '" placeholder="https://torrentio.strem.fun/…">' +
      '<div class="srow f" data-act="savetio">Save Torrentio link</div><div class="srow f" data-act="testtio">Test Torrentio</div><div class="srow f" data-act="resettio">Reset Torrentio link to default</div>' +
      '<div class="lbl">Subtitles</div>' +
      '<div class="srow f" data-act="sublang">Show subtitles in: <b>' + esc(Subs.langName(subPrefs().lang)) + '</b> (other languages are hidden)</div>' +
      '<div class="srow f" data-act="sublang2">Second language: <b>' + esc(subPrefs().lang2 ? Subs.langName(subPrefs().lang2) : 'None') + '</b></div>' +
      '<div class="srow f" data-act="subauto">Turn on the best matching subtitles automatically: <b>' + (subPrefs().auto ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="srow f" data-act="subautosync">Auto-sync subtitles when they are turned on (uses your server\'s processor): <b>' + (subPrefs().autosync ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="lbl">Playback</div>' +
      '<div class="srow f" data-act="playmode">Playback mode: <b>' + esc(PLAY_MODES[playMode()]) + '</b></div>' +
      '<div class="srow f" data-act="bufmode">Start-up buffering: <b>' + esc(BUF_MODES[Store.get('bufmode', 'auto')]) + '</b></div>' +
      '<div class="srow f" data-act="redodc">Run the device check again (tests which formats this device plays)</div>' +
      '<div class="srow f" data-act="forgetdev">Forget what this device can play: <b>' + (rep.good.length + rep.bad.length) + ' formats remembered</b></div>' +
      '<div class="hint">' + (rep.good.length ? 'Plays directly: ' + esc(rep.good.join(', ')) + '. ' : '') + (rep.bad.length ? 'Needs transcoding: ' + esc(rep.bad.join(', ')) + '. ' : '') + (rep.good.length + rep.bad.length ? '' : 'JoolzTV learns what this device can decode as you watch, so the next file of that kind starts the right way straight away.') + '</div>' +
      '<div class="hint">JoolzTV ' + esc(window.FLIX_VERSION || '') + '. Sources come from Torrentio (top 3 by seeds per resolution), posters from Cinemeta, subtitles from OpenSubtitles. Video plays through your own streaming server behind your JoolzApp sign-in. ' + esc(Sync.status()) + '</div></div></div>';
    replaceAll('settings', h, { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
  }

  /* ---------- actions ---------- */
  function act(el) {
    var a = el.getAttribute('data-act');
    if (a === 'page') return page(el.getAttribute('data-p'));
    if (a === 'open') { var m = reg[+el.getAttribute('data-k')]; return detail(m.type, m.id, m); }
    if (a === 'play') return Player.open(reg[+el.getAttribute('data-k')]);
    if (a === 'season') return renderEpisodes(current().el, +el.getAttribute('data-s'));
    if (a === 'pick') { var mm = menuEl, i = +el.getAttribute('data-i'), cb = mm._pick, o = mm._opts[i]; closeMenu(); return cb(o, i); }
    if (a === 'toggle') return el.classList.toggle('on');
    if (a === 'avatarmenu') return menu('Profile', [{ label: 'Switch profile', k: 'picker' }, { label: 'Settings', k: 'settings' }, { label: 'Sign out of this profile on this TV', k: 'signout' }], function (o) {
      if (o.k === 'picker') picker(); else if (o.k === 'settings') page('settings'); else doSignOut();
    });
    if (a === 'retryboot') return window.JTVBoot && JTVBoot();
    if (a === 'wizardgo') return wizardGo();
    if (a === 'devicego') return deviceGo();
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
    if (a === 'saveprofile') return saveProfile(el.getAttribute('data-id'));
    if (a === 'delprofile') return delProfile(el.getAttribute('data-id'));
    if (a === 'signout') return doSignOut();
    if (a === 'togglekeep') {
      var id = Store.active();
      if (Store.get('token', null)) { Store.delFor(id, 'token'); Store.setFor(id, 'remember', false); } else { Store.setFor(id, 'token', Backend.token()); Store.setFor(id, 'remember', true); }
      return settingsPage();
    }
    if (a === 'togglelib') {
      var dv = current().el._detail; if (!dv) return;
      var yes = !MyList.has(dv.id);
      MyList.set({ id: dv.id, name: dv.m.name, type: dv.type, poster: dv.m.poster }, yes);
      var bb = current().el.querySelector('#libbtn'); if (bb) bb.textContent = yes ? '✓  In My List' : '+  My List';
      return toast(yes ? 'Added to My List' : 'Removed from My List');
    }
    if (a === 'savetio') { var tu = document.getElementById('tio').value.trim().replace(/\/manifest\.json.*$/, '').replace(/\/+$/, ''); if (tu && !/^https?:\/\//.test(tu)) return toast('Link must start with https://'); Store.set('torrentio', tu); return Api.reload().then(function () { toast(tu ? 'Torrentio link saved' : 'Torrentio disabled'); }); }
    if (a === 'resettio') { Store.del('torrentio'); return Api.reload().then(function () { toast('Torrentio link reset to default'); settingsPage(); }); }
    if (a === 'testtio') {
      var tb = document.getElementById('tio').value.trim().replace(/\/manifest\.json.*$/, '').replace(/\/+$/, ''); toast('Testing Torrentio …', 15000);
      return fetch(tb + '/stream/movie/tt0111161.json').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { toast('Torrentio OK: ' + (j.streams || []).length + ' sources found for a test movie', 5000); })
        .catch(function (e) { toast('Cannot reach Torrentio: ' + e.message, 7000); });
    }
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
    if (closeMenu()) return true;
    var v = current();
    if (v && v.onBack && v.onBack() === true) return true;
    return pop();
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (el && Nav.root().contains(el)) act(el);
  });

  return { splash: splash, offline: offline, wizard: wizard, deviceSignin: deviceSignin, picker: picker, signedOut: signedOut, detail: detail, page: page, mount: mount, pop: pop, back: back,
           menu: menu, closeMenu: closeMenu, toast: toast, esc: esc, fmtTime: fmtTime, act: act, runSearch: runSearch, current: current, hasMenu: function () { return !!menuEl; } };
})();
