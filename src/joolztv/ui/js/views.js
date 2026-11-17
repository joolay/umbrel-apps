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
  var PAGES = ['home', 'movie', 'series', 'library', 'search', 'discover', 'settings'];
  function tabs() { return Tmdb.on() ? TABS.slice(0, 4).concat([['discover', 'Discover']], TABS.slice(4)) : TABS; }

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
    tabs().forEach(function (t) { h += '<div class="tab f' + (t[0] === active ? ' on' : '') + '" data-act="page" data-p="' + t[0] + '">' + t[1] + '</div>'; });
    h += '</div>';
    if (pr) h += '<div class="who glass f" data-act="avatarmenu"><span class="av" style="position:relative;overflow:hidden;background:' + esc(pr.color) + '">' + avHtml(pr) + '</span>' + esc(pr.name) + '</div>';
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
      '<div class="btn primary f" data-act="wizardgo">Sign in and continue</div>', null);
  }
  function wizardGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.addProfile(em, pw, '', null).then(function (r) {
      Profiles.setAll(r.profiles); finishSignIn(r.profile.id, em, r.token);
      Backend.setToken(r.token); deviceCheck(function () { qualityStep(function () { members(true); }); });
    }).catch(function (e) { ferr(e.message); });
  }
  /* a new device for an existing household: sign in with any member's account, the household comes down with it */
  function deviceSignin() {
    formView('devicesignin', 'Sign in to JoolzTV', 'Sign in with your JoolzApp account to use this household on this TV.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Password">' +
      '<div class="btn primary f" data-act="devicego">Sign in</div>', null);
  }
  function deviceGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter your JoolzApp email and password.');
    ferr('Signing in…');
    Backend.login(em, pw).then(function (r) {
      return Backend.household(r.token).then(function (h) {
        var me = h.profiles.filter(function (p) { return p.self; })[0];
        if (!me) throw new Error('That account is not part of this household.');
        Profiles.setAll(h.profiles); finishSignIn(me.id, em, r.token); enter(me.id);
      });
    }).catch(function (e) { ferr(e.message); });
  }
  /* The sign-in is always kept on the device. How long it lasts is the server's call: 90 days since the household was last used. */
  function finishSignIn(id, email, token) {
    Store.setFor(id, 'email', email); Store.setFor(id, 'token', token);
    Profiles.setActive(id);
  }

  /* "Who's watching?" */
  function picker() {
    ++browseToken; Tmdb.forget();
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
  function signin(p, msg) {
    var em = Store.getFor(p.id, 'email', '');
    formView('signin', 'Hi ' + p.name, 'Sign in with your JoolzApp account to continue.',
      '<input id="em" class="field f" type="email" placeholder="JoolzApp email" autocomplete="off" value="' + esc(em) + '"><input id="pw" class="field f" type="password" placeholder="Password">' +
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
        Profiles.setAll(h.profiles); finishSignIn(id, em, r.token); enter(id, r.token);
      });
    }).catch(function (e) { ferr(e.message); });
  }
  function enter(id, token) {
    if (!DeviceTest.done()) { Store.setActive(id); if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token()); return deviceCheck(function () { enter(id, token); }); }
    Store.setActive(id);
    if (token) Backend.setToken(token); else Backend.setToken(Store.getFor(id, 'token', null) || Backend.token());
    Api.setStreamBase('');
    Backend.household().then(function (h) { Profiles.setAll(h.profiles); Api.setPrefs(h.prefs); }).catch(function () {}).then(function () { return Tmdb.init(); }).then(function () {
      if (Store.active() !== id) return;
      Sync.run(function () { var v = current(); if (v && PAGES.indexOf(v.name) >= 0 && v.name === 'home') page('home'); });
      if (!Api.quality()) return qualityStep(function () { page('home'); });          // a household set up before this question existed
      page('home');
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
  }
  function addMember() {
    formView('addmember', 'Add a household member', 'Each profile is one JoolzApp account. Enter that person\'s JoolzApp email and password. They stay signed in as long as anyone in the household keeps using JoolzTV.',
      '<input id="em" class="field f" type="email" placeholder="Their JoolzApp email" autocomplete="off"><input id="pw" class="field f" type="password" placeholder="Their password">' +
      '<div class="btn primary f" data-act="addmembergo">Add to household</div><div class="btn glass f" data-act="membersback">Cancel</div>',
      function () { members(false); return true; });
  }
  function addMemberGo() {
    var em = val('em').toLowerCase(), pw = document.getElementById('pw').value;
    if (!em || !pw) return ferr('Enter their JoolzApp email and password.');
    ferr('Adding…');
    Backend.addProfile(em, pw, '', Backend.token()).then(function (r) {
      Profiles.setAll(r.profiles); Store.setFor(r.profile.id, 'email', em);
      toast(r.profile.name + ' added'); members(false);
    }).catch(function (e) { ferr(e.message); });
  }
  function editProfile(id) {
    var p = Profiles.get(id); if (!p) return;
    var h = '<div class="center"><div class="form glass"><h1>' + esc(p.name) + '</h1><div class="sub">' + (p.owner ? 'Household owner' : 'Household member') + '</div><div class="err" id="ferr"></div>' +
      '<div class="pav" style="width:150px;height:150px;border-radius:75px;margin:0 auto 18px;background:' + esc(p.color) + '">' + avHtml(p) + '</div>' +
      '<input id="nm" class="field f" maxlength="16" placeholder="Name" autocomplete="off" value="' + esc(p.name) + '">' +
      '<div class="btn glass f" data-act="pickavatar" data-id="' + esc(id) + '">Change picture</div>' +
      (Tmdb.on() && (Profiles.active() && Profiles.active().owner) ? '<div class="btn glass f" data-act="agelimit" data-id="' + esc(id) + '">Age limit: ' + (p.maxAge ? 'up to ' + p.maxAge : 'none') + '</div>' : '') +
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
    if (kind === 'search') return searchPage();
    if (kind === 'settings') return settingsPage();
    if (kind === 'discover') return discoverPage();
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
    defs.forEach(function () { var s = document.createElement('div'); rows.appendChild(s); slots.push(s); });
    var pending = defs.length + trows.length;
    function done() { if (--pending === 0 && token === browseToken && !rows.querySelector('.row')) main.innerHTML = '<div class="empty">Nothing to show right now. Check your internet connection.</div>'; }
    trows.forEach(function (r, i) {
      r.load().then(function (items) {
        if (token !== browseToken || !items.length) return;
        tslots[i].innerHTML = rowHtml(r.title, items.map(tmdbMeta)); Nav.hydrate(); focusFirst();
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
    replaceAll('search', '<div class="art img"></div><div class="art-shade"></div>' + topbar('search') + '<div class="vs" id="main"><div class="grid" style="padding-top:150px"><div class="sbar"><input id="q" class="field f" type="text" style="width:960px" placeholder="Search movies, TV shows and people" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><div class="btn glass f mic" data-act="speak" aria-label="Search by voice">' + MIC + '<span>Speak</span></div></div><div class="hint" id="vhint"></div><div id="res"></div></div></div>',
      { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('#q');
    var q = document.getElementById('q');
    // voice typed through the TV's keyboard microphone arrives as text without Enter: search once it stops changing
    var lastQ = '';
    function auto() { var v = q.value.trim(); if (v.length >= 2 && v !== lastQ) { lastQ = v; runSearch(v); } }
    q.addEventListener('input', function () { clearTimeout(q._t); q._t = setTimeout(auto, 900); });
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
    q.focus();
    if (hint) hint.textContent = 'Press the microphone key on the keyboard that just opened (or hold the Magic Remote\u2019s microphone button) and say a title. The words are typed in and searched automatically.';
  }
  function runSearch(q) {
    var res = document.getElementById('res'); if (!res || !q) return;
    res.innerHTML = '<div class="skel">Searching…</div>';
    var people = Tmdb.on() ? Tmdb.search(q).then(function (r) { return r.people || []; }).catch(function () { return []; }) : Promise.resolve([]);
    Promise.all([Api.ensure().then(function () { return Api.search(q); }), people]).then(function (all) {
      var metas = all[0], ppl = all[1];
      if (!document.getElementById('res')) return;
      if (!metas.length && !ppl.length) { res.innerHTML = '<div class="skel">No results for “' + esc(q) + '”.</div>'; return; }
      var h = ''; if (ppl.length) h += '<div class="gl">People</div><div class="prow">' + ppl.map(personCard).join('') + '</div><div class="gl">Titles</div>';
      metas.slice(0, 48).forEach(function (m) { h += card(m); });
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
    else if (kind === 'movie') { L('Trending today', 'trending', 'movie'); L('Popular', 'popular', 'movie'); L('Top rated', 'top', 'movie'); L('Now in cinemas', 'now', 'movie'); L('Coming soon', 'soon', 'movie'); }
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
    if (info._direct || !Tmdb.on() || !Tmdb.restricted() || !/^tt\d+$/.test(id)) return Player.open(info);
    Tmdb.playCheck(id, info.type).then(function (r) {
      if (r.ok) return Player.open(info);
      menu('Not available on this profile', [{ label: 'OK' }], function () {}, r.message || 'This title is not suitable for this profile.');
    });
  }
  function personCard(p) {
    return '<div class="pc f" data-act="person" data-id="' + esc(p.id) + '"><div class="ph img" data-bg="' + esc(p.photo || '') + '"></div><div class="n">' + esc(p.name) + '</div>' + (p.role || p.department ? '<div class="r">' + esc(p.role || p.department) + '</div>' : '') + '</div>';
  }
  function certChip(c) { return c && c.rating ? '<span class="chip cert">' + esc(c.rating) + '</span>' : ''; }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return '';
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
    Tmdb.collection(id).then(function (c) { gridView('collection', '<div class="ptext"><h1>' + esc(c.name) + '</h1><div class="desc">' + esc(c.overview) + '</div></div>', c.items, false); }).catch(function () { toast('Could not load that collection', 4000); });
  }
  var DISC = { type: 'movie', genre: '', genreName: 'Any genre', year: '', sort: 'popular', page: 1 };
  var SORT_NAMES = { popular: 'Most popular', rating: 'Highest rated', newest: 'Newest', az: 'A to Z' };
  function discoverPage() {
    var token = ++browseToken;
    var chips = '<span class="chip f" data-act="dtype">' + (DISC.type === 'movie' ? 'Films' : 'TV shows') + '</span><span class="chip f" data-act="dgenre">' + esc(DISC.genreName) + '</span>' +
      '<span class="chip f" data-act="dyear">' + (DISC.year || 'Any year') + '</span><span class="chip f" data-act="dsort">' + esc(SORT_NAMES[DISC.sort]) + '</span>';
    replaceAll('discover', '<div class="art-shade"></div>' + topbar('discover') + '<div class="vs" id="main"><div class="grid" id="gridp"><div class="gh"><h1>Discover</h1><div class="chips">' + chips + '</div></div><div id="gcards"><div class="skel">Loading…</div></div><div id="gmoreh"></div></div></div>',
      { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
    discoverLoad(token);
  }
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
    enrichDetail(el, type, id, m);
  }
  function renderEpisodes(el, season) {
    var D = el._detail, list = el.querySelector('#eplist'), eps = D.S.by[season] || [], h = '';
    eps.forEach(function (v) {
      var r = Resume.get(v.id), pct = r && r.d ? Math.min(1, r.t / r.d) : 0;
      var info = Object.assign({}, D.base, { videoId: v.id, startMs: r && !r.done ? r.t : 0, sub: 'S' + v.season + ':E' + v.episode, epTitle: v.title || v.name });
      h += '<div class="ep glass f" data-ep="' + (v.episode || v.number || '') + '" data-act="play" data-k="' + ref(info) + '"><div class="img" data-bg="' + esc(v.thumbnail || D.m.background || '') + '"' + (v.thumbnail ? ' data-has="1"' : '') + '></div>' +
        '<div class="t">' + (v.episode || v.number || '') + '. ' + esc(v.title || v.name || 'Episode') + '</div><div class="o">' + esc(v.overview || v.description || '') + '</div>' +
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
    else if (!Tmdb.on()) h += '<div class="hint">Titles with logos, cast, age ratings, trending lists and Discover switch on when a JoolzApp admin adds a TMDB key here.</div>';
    return h + '<div class="hint">This product uses the TMDB API but is not endorsed or certified by TMDB.</div>';
  }
  function settingsPage() {
    ++browseToken;
    var pr = Profiles.active(), rep = Api.deviceReport();
    var h = '<div class="art-shade"></div>' + topbar('settings') + '<div class="vs" id="main" data-pad-top="140"><div class="settings"><h1>Settings</h1>' +
      '<div class="lbl">Profile – ' + esc(pr ? pr.name : '') + '</div>' +
      '<div class="srow f" data-act="members">Household: add, rename or remove profiles</div>' +
      '<div class="srow f" data-act="picker">Switch profile</div>' +
      '<div class="srow f" data-act="signout">Sign out of this profile on this TV</div>' +
      '<div class="lbl">Sources (the whole household)</div>' +
      '<div class="srow f" data-act="quality">Preferred quality for automatic playback: <b>' + esc(Api.quality() || 'Not chosen') + '</b></div>' +
      '<div class="srow f" data-act="sourcespage">Sources and filters: <b>' + esc(Sources.summary(Api.sourcesCfg())) + '</b></div>' +
      tmdbSettingsRows() +
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
      '<div class="hint">JoolzTV ' + esc(window.FLIX_VERSION || '') + '. The top 3 sources by seeds are offered per resolution; posters come from Cinemeta and subtitles from OpenSubtitles. Video plays through your own streaming server behind your JoolzApp sign-in. You stay signed in while anyone in the household uses JoolzTV; after 90 days with no use everyone signs in again. ' + esc(Sync.status()) + '</div></div></div>';
    replaceAll('settings', h, { cls: 'noart', onBack: function () { page('home'); return true; } });
    Nav.first('.tab.on');
  }

  /* ---------- actions ---------- */
  function act(el) {
    var a = el.getAttribute('data-act');
    if (a === 'page') return page(el.getAttribute('data-p'));
    if (a === 'open') { var m = reg[+el.getAttribute('data-k')]; if (!m.id && m.tmdb) return openTmdb(m); return detail(m.type, m.id, m); }
    if (a === 'play') return playChecked(reg[+el.getAttribute('data-k')]);
    if (a === 'season') return renderEpisodes(current().el, +el.getAttribute('data-s'));
    if (a === 'speak') return speak();
    if (a === 'xtab') return xTab(current().el, el.getAttribute('data-t'));
    if (a === 'person') return personPage(el.getAttribute('data-id'));
    if (a === 'collection') return collectionPage(el.getAttribute('data-id'));
    if (a === 'dtype' || a === 'dsort' || a === 'dyear' || a === 'dgenre') return discoverMenu(a);
    if (a === 'dmore') { DISC.page++; var mh = document.getElementById('gmoreh'); if (mh) mh.innerHTML = ''; return discoverLoad(); }
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
    if (a === 'pickavatar') return avatarPage(el.getAttribute('data-id'));
    if (a === 'setavatar') return setAvatar(el.getAttribute('data-id'), el.getAttribute('data-v'));
    if (a === 'saveprofile') return saveProfile(el.getAttribute('data-id'));
    if (a === 'delprofile') return delProfile(el.getAttribute('data-id'));
    if (a === 'signout') return doSignOut();
    if (a === 'togglelib') {
      var dv = current().el._detail; if (!dv) return;
      var yes = !MyList.has(dv.id);
      MyList.set({ id: dv.id, name: dv.m.name, type: dv.type, poster: dv.m.poster }, yes);
      var bb = current().el.querySelector('#libbtn'); if (bb) bb.textContent = yes ? '✓  In My List' : '+  My List';
      return toast(yes ? 'Added to My List' : 'Removed from My List');
    }
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
