/* Views: login, browse (home/movies/series/library), search, detail, settings, menus. */
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
  var app = document.getElementById('app'), stack = [], reg = [], seq = 0, menuEl = null, menuPrev = null, toastT = null;

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

  /* ---------- menu (modal list) ---------- */
  function menu(title, opts, onPick, hint) {
    closeMenu(true);
    menuPrev = { root: Nav.root(), cur: Nav.cur() };
    var h = '<div class="menu"><h3>' + esc(title) + '</h3><div class="list mvs" data-pad-top="10">';
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
  var TABS = [['home', 'Home'], ['movie', 'Movies'], ['series', 'TV Shows'], ['library', 'My List'], ['search', 'Search'], ['settings', 'Settings']];
  var PAGE_NAMES = { home: '', movie: 'Movies', series: 'TV Shows', library: 'My List', search: 'Search', settings: 'Settings' };
  function topbar(active) {
    var pr = Profiles.active(), who = pr ? '<div class="who f" data-act="profiles"><span class="av" style="background:' + esc(pr.color) + '">' + esc(pr.name.charAt(0).toUpperCase()) + '</span>' + esc(pr.name) + '</div>' : '';
    return '<div class="top"><div class="logo f" data-act="menu">TORRENTFLIX</div><div class="pg">' + esc(PAGE_NAMES[active] || '') + '</div><div class="sp"></div>' + who + '</div>';
  }
  var sideEl = null, sidePrev = null, infoT = null;
  function openSide() {
    if (sideEl || menuEl) return;
    var v = current(); if (!v || ['home', 'movie', 'series', 'library', 'search', 'settings'].indexOf(v.name) < 0) return;
    sidePrev = { root: Nav.root(), cur: Nav.cur() };
    var h = '<div class="sidepanel"><div class="slogo">TORRENTFLIX</div>';
    TABS.forEach(function (t) { h += '<div class="sitem f' + (t[0] === v.name ? ' on' : '') + '" data-act="page" data-p="' + t[0] + '">' + t[1] + '</div>'; });
    h += '<div class="sitem f" data-act="profiles">Switch Profile</div><div class="sitem f" data-act="exit">Exit</div></div>';
    sideEl = document.createElement('div'); sideEl.className = 'side'; sideEl.innerHTML = h; app.appendChild(sideEl);
    Nav.setRoot(sideEl); var on = sideEl.querySelector('.sitem.on'); if (on) Nav.set(on);
  }
  function closeSide(restore) {
    if (!sideEl) return false;
    app.removeChild(sideEl); sideEl = null;
    if (restore !== false && sidePrev) { Nav.setRoot(sidePrev.root, true); if (sidePrev.cur) Nav.set(sidePrev.cur, true); }
    return true;
  }
  function showInfo(m) {
    var el = document.getElementById('info'); if (!el || !m) return;
    var r = m._resume ? '<div class="meta"><b>Resume</b><span>' + esc(fmtTime(m._resume.t)) + ' of ' + esc(fmtTime(m._resume.d)) + '</span></div>' : '<div class="meta">' + meta1(m) + '</div>';
    el.innerHTML = '<h1>' + esc(m.name) + '</h1>' + r + '<div class="desc">' + esc(m.description || '') + '</div>';
  }
  Nav.onFocus(function (el) {
    if (!el || !el.classList || !el.classList.contains('card')) return;
    var k = el.getAttribute('data-k'); if (k == null) return;
    clearTimeout(infoT); infoT = setTimeout(function () { showInfo(reg[+k]); }, 120);
  });

  function card(m, extra) {
    var k = ref(m), bar = '';
    if (extra && extra.pct != null) bar = '<div class="barbg"></div><div class="bar" style="width:' + Math.round(extra.pct * 100) + '%"></div>';
    return '<div class="card f" data-act="open" data-k="' + k + '"><div class="img" data-bg="' + esc(m.poster || '') + '"></div>' +
      '<div class="cap">' + esc(m.name) + '</div>' + bar + '</div>';
  }
  function rowHtml(title, metas, extraFn) {
    var h = '<div class="row"><h2>' + esc(title) + '</h2><div class="hs">';
    metas.slice(0, 20).forEach(function (m) { h += card(m, extraFn ? extraFn(m) : null); });
    return h + '<span class="pad-end"></span></div></div>';
  }
  function meta1(m) {
    var bits = [];
    if (m.imdbRating) bits.push('<b>★ ' + esc(m.imdbRating) + '</b>');
    if (m.releaseInfo || m.year) bits.push('<span>' + esc(m.releaseInfo || m.year) + '</span>');
    if (m.runtime) bits.push('<span>' + esc(m.runtime) + '</span>');
    if (m.genres && m.genres.length) bits.push('<span>' + esc(m.genres.slice(0, 3).join(' • ')) + '</span>');
    return bits.join('');
  }

  /* ---------- login ---------- */
  function login(msg) {
    mount('login', '<div class="center"><div class="form"><h1>Sign in to Stremio</h1><div class="err" id="lerr">' + esc(msg || '') + '</div>' +
      '<input id="email" class="field f" type="email" placeholder="Stremio email" autocomplete="off" value="' + esc(Store.get('email', '')) + '">' +
      '<input id="pass" class="field f" type="password" placeholder="Password">' +
      '<div class="btn f" data-act="dologin" style="background:#e50914">Sign in</div>' +
      '<div class="btn f" data-act="skiplogin">Browse without an account</div>' +
      '<div class="hint">Your library and addons come from your Stremio account. Signed up with Facebook? Set a password first at stremio.com/reset-password on your phone or computer, then sign in here.</div></div></div>');
    Nav.first('.f');
  }
  function doLogin() {
    var e = document.getElementById('email').value.trim(), p = document.getElementById('pass').value;
    var err = document.getElementById('lerr');
    if (!e || !p) { err.textContent = 'Enter your email and password.'; return; }
    err.textContent = 'Signing in…';
    Api.login(e, p).then(function () { return Api.reload(); }).then(function () { page('home'); toast('Signed in'); })
      .catch(function (x) { err.textContent = 'Could not sign in: ' + x.message; });
  }

  /* ---------- browse pages ---------- */
  var browseToken = 0;
  function page(kind) {
    closeSide(false);
    if (kind === 'search') return searchPage();
    if (kind === 'settings') return settingsPage();
    var token = ++browseToken, browse = kind !== 'library';
    var el = replaceAll(kind, topbar(kind) + (browse ? '<div id="info"></div>' : '') + '<div class="vs' + (browse ? ' rows snap' : '') + '" id="main"><div class="loading">Loading…</div></div>',
      { onBack: function () { openSide(); return true; } });
    Nav.first('.logo');
    Api.ensure().then(function () {
      if (token !== browseToken) return;
      if (kind === 'library') return buildLibrary(el, token);
      buildBrowse(kind, el, token);
    }).catch(function (e) {
      if (token !== browseToken) return;
      el.querySelector('#main').innerHTML = '<div class="empty">Could not load data: ' + esc(e.message) + '</div>';
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
      if (!Nav.cur() || !Nav.root().contains(Nav.cur()) || Nav.cur().classList.contains('logo')) { Nav.set(c); showInfo(reg[+c.getAttribute('data-k')]); }
    }
    if (kind === 'home') {
      var slot0 = document.createElement('div'); rows.appendChild(slot0);
      continueItems().then(function (cont) {
        if (token !== browseToken || !cont.length) return;
        slot0.innerHTML = rowHtml('Continue Watching', cont.map(function (r) { return { type: r.type, id: r.id, name: r.name, poster: r.poster, _resume: r }; }), function (m) { return { pct: m._resume.t / m._resume.d }; });
        Nav.hydrate(); focusFirst();
      });
    }
    defs.forEach(function (d, i) { var s = document.createElement('div'); rows.appendChild(s); slots.push(s); });
    var pending = defs.length;
    function done() { if (--pending === 0 && token === browseToken && !rows.querySelector('.row')) main.innerHTML = '<div class="empty">Nothing to show right now. Check your internet connection.</div>'; }
    defs.forEach(function (d, i) {
      Api.fetchCatalog(d).then(function (metas) {
        if (token !== browseToken || !metas.length) return;
        var title = (d.name || d.id) + ' – ' + (d.type === 'movie' ? 'Movies' : 'TV Shows');
        slots[i].innerHTML = rowHtml(title, metas);
        Nav.hydrate(); focusFirst();
      }).catch(function () {}).then(done);
    });
    Nav.hydrate();
  }
  function continueItems() {
    return Api.getContinue().catch(function () { return []; }).then(function (remote) {
      var map = {};
      remote.concat(Resume.list()).forEach(function (r) { var o = map[r.id]; if (!o || (r.ts || 0) > (o.ts || 0)) map[r.id] = r; });
      return Object.keys(map).map(function (k) { return map[k]; }).sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); }).slice(0, 20);
    });
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
    replaceAll('search', topbar('search') + '<div class="vs" id="main"><div class="grid" style="padding-top:120px"><input id="q" class="field f" style="width:1100px" placeholder="Search movies and series" autocomplete="off"><div id="res"></div></div></div>',
      { onBack: function () { openSide(); return true; } });
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

  /* ---------- details ---------- */
  function openItem(m) {
    if (m._resume) { return detail(m.type, m.id, m); }
    detail(m.type, m.id, m);
  }
  function detail(type, id, seed) {
    var el = mount('detail', '<div class="detail"><div class="poster img" data-keep="1" data-bg="' + esc(seed && seed.poster || '') + '"></div><div class="vs" id="dmain"><div class="info"><h1 class="title-big">' + esc(seed && seed.name || '') + '</h1><div class="meta">Loading…</div></div></div></div>');
    Nav.hydrate();
    Api.ensure().then(function () { return Promise.all([Api.getMeta(type, id), Api.getLibraryAll().catch(function () { return []; })]); }).then(function (r) { var m = r[0];
      if (stack[stack.length - 1].el !== el) return;
      renderDetail(el, type, id, m, seed);
    }).catch(function (e) {
      var info = el.querySelector('.info'); if (info) info.innerHTML = '<h1 class="title-big">' + esc(seed && seed.name || '') + '</h1><div class="meta">Could not load details: ' + esc(e.message) + '</div>';
    });
  }
  function seasonsOf(m) {
    var by = {};
    (m.videos || []).forEach(function (v) { var s = v.season == null ? 0 : v.season; (by[s] = by[s] || []).push(v); });
    var keys = Object.keys(by).map(Number).sort(function (a, b) { return (a === 0) - (b === 0) || a - b; });
    keys.forEach(function (k) { by[k].sort(function (a, b) { return (a.episode || a.number || 0) - (b.episode || b.number || 0); }); });
    return { by: by, keys: keys };
  }
  function renderDetail(el, type, id, m, seed) {
    var isSeries = type === 'series' && m.videos && m.videos.length, S = isSeries ? seasonsOf(m) : null;
    var l1 = Resume.lastFor(id), l2 = Api.remoteLast(id), last = (l2 && (!l1 || l2.ts > (l1.ts || 0))) ? l2 : l1, playVid = id, playLabel = '▶ Play', start = 0, sub = '';
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
        if (!last.done) { playVid = last.videoId; start = last.t; playLabel = '▶ Resume'; sub = 'S' + last.season + ':E' + last.episode; season = last.season != null ? last.season : season; }
        else { for (var i = 0; i < flat.length; i++) if (flat[i].id === last.videoId && flat[i + 1]) { playVid = flat[i + 1].id; sub = 'S' + flat[i + 1].season + ':E' + flat[i + 1].episode; season = flat[i + 1].season; } }
      }
    } else if (last && !last.done) { start = last.t; playLabel = '▶ Resume'; }
    var info = Object.assign({}, baseInfo, { videoId: playVid, startMs: start });
    if (isSeries) { info.sub = sub; }
    var k = ref(info), k2 = ref(Object.assign({}, info, { pick: true }));
    var h = '<div class="info"><h1 class="title-big">' + esc(m.name) + '</h1>' +
      '<div class="meta">' + meta1(m) + '</div><div class="desc" style="max-height:170px">' + esc(m.description || '') + '</div>' +
      '<div class="btns"><div class="btn f" data-act="play" data-k="' + k + '">' + playLabel + (isSeries && sub ? ' ' + sub : '') + '</div>' +
      '<div class="btn f" data-act="play" data-k="' + k2 + '">Choose source</div>' +
      '<div class="btn f" data-act="togglelib" id="libbtn">' + (MyList.has(id) ? '✓ In My List' : '+ My List') + '</div></div></div>';
    if (isSeries) {
      h += '<div class="eps" id="eps"><div class="chips" id="seasons">';
      S.keys.forEach(function (s) { h += '<span class="chip f' + (s === season ? ' on' : '') + '" data-act="season" data-s="' + s + '">' + (s === 0 ? 'Specials' : 'Season ' + s) + '</span>'; });
      h += '</div><div id="eplist"></div></div>';
    }
    var d = el.querySelector('#dmain'); d.innerHTML = h; d.scrollTop = 0;
    el._detail = { type: type, id: id, m: m, S: S, base: baseInfo };
    var po = el.querySelector('.detail .poster'); if (po && m.poster) { po.setAttribute('data-bg', m.poster); po.setAttribute('data-on', '0'); }
    if (isSeries) renderEpisodes(el, season);
    Nav.hydrate();
    Nav.first('.btn');
  }
  function renderEpisodes(el, season) {
    var D = el._detail, list = el.querySelector('#eplist'), eps = D.S.by[season] || [], h = '';
    eps.forEach(function (v) {
      var r = Resume.get(v.id), rl = Api.remoteLast(D.id); if (rl && rl.videoId === v.id && (!r || rl.ts > (r.ts || 0))) r = rl;
      var pct = r && r.d ? Math.min(1, r.t / r.d) : 0;
      var info = Object.assign({}, D.base, { videoId: v.id, startMs: r && !r.done ? r.t : 0, sub: 'S' + v.season + ':E' + v.episode, epTitle: v.title || v.name });
      h += '<div class="ep f" data-act="play" data-k="' + ref(info) + '"><div class="img" data-bg="' + esc(v.thumbnail || D.m.background || '') + '"></div>' +
        '<div class="t">' + (v.episode || v.number || '') + '. ' + esc(v.title || v.name || 'Episode') + '</div><div class="o">' + esc(v.overview || v.description || '') + '</div>' +
        (pct > 0.02 ? '<div class="bar" style="width:' + Math.round(pct * 267) + 'px"></div>' : '') + '</div>';
    });
    list.innerHTML = h || '<div class="skel">No episodes.</div>';
    Array.prototype.forEach.call(el.querySelectorAll('.chip'), function (c) { c.classList.toggle('on', Number(c.getAttribute('data-s')) === Number(season)); });
    Nav.hydrate();
  }

  /* ---------- settings ---------- */
  function settingsPage() {
    ++browseToken;
    var email = Store.get('email', ''), signed = !!Api.authKey();
    var h = topbar('settings') + '<div class="vs" id="main"><div class="settings"><h1>Settings</h1>' +
      '<div class="lbl">STREAM SOURCE – TORRENTIO (optional: configure at torrentio.strem.fun and paste the link here)</div>' +
      '<input id="tio" class="field f" value="' + esc(Api.torrentioUrl()) + '" placeholder="https://torrentio.strem.fun/…">' +
      '<div class="srow f" data-act="savetio">Save Torrentio link</div>' +
      '<div class="srow f" data-act="testtio">Test Torrentio</div>' +
      '<div class="srow f" data-act="resettio">Reset Torrentio link to default</div>' +
      '<div class="lbl">PROFILE SYNC (Torrentflix on your Umbrel)</div>' +
      (Sync.webMode() ? '<div class="srow">Profiles, lists and progress are stored on your Umbrel automatically. ' + esc(Sync.status()) + '</div>' :
        '<input id="syncurl" class="field f" value="' + esc(Store.get('syncurl', '')) + '" placeholder="http://umbrel.local:11580  (leave empty to keep profiles on this TV only)">' +
        '<div class="srow f" data-act="savesync">Save and sync now</div><div class="srow">' + esc(Sync.status()) + '</div>') +
      '<div class="lbl">STREAMING SERVER (your Umbrel)</div><input id="srv" class="field f" value="' + esc(Api.server()) + '" placeholder="http://192.168.1.50:11470">' +
      '<div class="srow f" data-act="saveserver">Save server address</div>' +
      '<div class="srow f" data-act="testserver">Test server connection</div>' +
      '<div class="srow f" data-act="toggletc">Always transcode to HLS (use if video stutters or won\'t play): <b>' + (Store.get('transcode', false) ? 'ON' : 'OFF') + '</b></div>' +
      '<div class="lbl">STREMIO ACCOUNT FOR THIS PROFILE (optional – only for Stremio progress sync)</div>' +
      (signed ? '<div class="srow f" data-act="signout">Signed in as ' + esc(email) + ' – Sign out</div>' : '<div class="srow f" data-act="gologin">Sign in to Stremio</div>') +
      (signed ? '<div class="srow f" data-act="togglesync">Sync watch progress to your Stremio account: <b>' + (Store.get('sync', true) === false ? 'OFF' : 'ON') + '</b></div>' : '') +
      '<div class="hint">Torrentflix ' + (window.FLIX_VERSION || '') + '. Sources come only from Torrentio, shown as the top 3 by seeds for each resolution. Posters and details come from Cinemeta. Playback runs through your own streaming server.</div></div></div>';
    replaceAll('settings', h, { onBack: function () { openSide(); return true; } });
    Nav.first('#tio');
  }

  /* ---------- profiles ---------- */
  var editing = null;
  function avatar(p, cls) { return '<div class="pav ' + (cls || '') + '" style="background:' + esc(p.color) + '">' + esc(p.name.charAt(0).toUpperCase()) + '</div>'; }
  function profilesView(manage) {
    closeSide(false); ++browseToken;
    var ps = Profiles.all(), h = '<div class="plist"><h1>' + (manage ? 'Manage Profiles' : 'Who\'s watching?') + '</h1><div class="ptiles">';
    ps.forEach(function (p) {
      h += '<div class="ptile f" data-act="' + (manage ? 'editprofile' : 'selprofile') + '" data-id="' + esc(p.id) + '">' + avatar(p, manage ? 'edit' : '') + (manage ? '<div class="pen">✎</div>' : '') + '<div class="pn">' + esc(p.name) + '</div></div>';
    });
    if (ps.length < Profiles.MAX) h += '<div class="ptile f" data-act="addprofile"><div class="pav add">+</div><div class="pn">Add Profile</div></div>';
    h += '</div><div class="btn f pbtn2" data-act="' + (manage ? 'doneprofiles' : 'manageprofiles') + '">' + (manage ? 'Done' : 'Manage Profiles') + '</div></div>';
    replaceAll('profiles', h, { onBack: function () { if (manage) { profilesView(false); return true; } if (Profiles.active()) { page('home'); return true; } return false; } });
    var act = Profiles.active(), first = null;
    if (act) first = Nav.root().querySelector('.ptile[data-id="' + act.id + '"]');
    Nav.set(first || Nav.root().querySelector('.ptile'));
  }
  function profileForm(id) {
    var p = id ? Profiles.get(id) : null;
    editing = { id: id, color: p ? p.color : Profiles.COLORS[Profiles.all().length % Profiles.COLORS.length] };
    var h = '<div class="center"><div class="form"><h1>' + (p ? 'Edit Profile' : 'Add Profile') + '</h1><input id="pname" class="field f" maxlength="16" placeholder="Profile name" autocomplete="off" value="' + esc(p ? p.name : '') + '"><div class="swatches">';
    Profiles.COLORS.forEach(function (c) { h += '<span class="sw f' + (c === editing.color ? ' on' : '') + '" data-act="swatch" data-c="' + c + '" style="background:' + c + '"></span>'; });
    h += '</div><div class="btn f" data-act="saveprofile" style="background:#e50914">Save</div>' +
      (p && Profiles.all().length > 1 ? '<div class="btn f" data-act="delprofile">Delete this profile</div>' : '') +
      '<div class="btn f" data-act="cancelprofile">Cancel</div><div class="hint">Each profile keeps its own My List and watch progress.</div></div></div>';
    replaceAll('profiles', h, { onBack: function () { profilesView(!!id); return true; } });
    Nav.set(Nav.root().querySelector('#pname'));
  }

  /* ---------- actions ---------- */
  function act(el) {
    var a = el.getAttribute('data-act');
    if (a === 'page') return page(el.getAttribute('data-p'));
    if (a === 'menu') return openSide();
    if (a === 'profiles') return profilesView(false);
    if (a === 'manageprofiles') return profilesView(true);
    if (a === 'doneprofiles') return profilesView(false);
    if (a === 'selprofile') { Profiles.setActive(el.getAttribute('data-id')); Api.resetAccount(); return page('home'); }
    if (a === 'editprofile') return profileForm(el.getAttribute('data-id'));
    if (a === 'addprofile') return profileForm(null);
    if (a === 'swatch') { editing.color = el.getAttribute('data-c'); Array.prototype.forEach.call(Nav.root().querySelectorAll('.sw'), function (x) { x.classList.toggle('on', x === el); }); return; }
    if (a === 'saveprofile') {
      var nm = document.getElementById('pname').value.trim(); if (!nm) return toast('Enter a name');
      if (editing.id) Profiles.update(editing.id, nm, editing.color); else { var np = Profiles.add(nm, editing.color); if (!np) return toast('Maximum of ' + Profiles.MAX + ' profiles'); }
      return profilesView(true);
    }
    if (a === 'delprofile') {
      if (!Profiles.remove(editing.id)) return toast('Cannot delete the last profile');
      toast('Profile deleted'); return profilesView(true);
    }
    if (a === 'cancelprofile') return profilesView(!!editing.id);
    if (a === 'exit') { try { window.close(); } catch (e) {} return; }
    if (a === 'open') return openItem(reg[+el.getAttribute('data-k')]);
    if (a === 'play') return Player.open(reg[+el.getAttribute('data-k')]);
    if (a === 'season') { var v = current(); return renderEpisodes(v.el, +el.getAttribute('data-s')); }
    if (a === 'pick') { var m = menuEl; var i = +el.getAttribute('data-i'); var cb = m._pick, o = m._opts[i]; closeMenu(); return cb(o, i); }
    if (a === 'togglelib') {
      var dv = current().el._detail; if (!dv) return;
      var yes = !MyList.has(dv.id), meta = { id: dv.id, name: dv.m.name, type: dv.type, poster: dv.m.poster };
      MyList.set(meta, yes);
      var bb = current().el.querySelector('#libbtn'); if (bb) bb.textContent = yes ? '✓ In My List' : '+ My List';
      toast(yes ? 'Added to My List' : 'Removed from My List');
      if (Api.authKey()) Api.setInLibrary(meta, yes).catch(function () {});   // also mirror to the profile's Stremio library
      return;
    }
    if (a === 'savesync') {
      var su = document.getElementById('syncurl').value.trim().replace(/\/+$/, ''); if (su && !/^https?:\/\//.test(su)) return toast('Address must start with http://');
      Store.set('syncurl', su); toast(su ? 'Syncing…' : 'Sync turned off', 6000);
      return Sync.run(function (ok) { toast(ok ? 'Synced with your Umbrel' : Sync.status(), 5000); settingsPage(); });
    }
    if (a === 'togglesync') { Store.set('sync', Store.get('sync', true) === false); return settingsPage(); }
    if (a === 'dologin') return doLogin();
    if (a === 'skiplogin') { Store.set('skiplogin', true); return page('home'); }
    if (a === 'gologin') return login();
    if (a === 'signout') { Api.logout(); toast('Signed out'); return page('home'); }
    if (a === 'saveserver') { var u = document.getElementById('srv').value.trim().replace(/\/+$/, ''); if (!/^https?:\/\//.test(u)) { return toast('Address must start with http://'); } Store.set('server', u); return toast('Saved: ' + u); }
    if (a === 'testserver') {
      var u2 = document.getElementById('srv').value.trim().replace(/\/+$/, ''); toast('Testing ' + u2 + ' …', 8000);
      return fetch(u2 + '/settings').then(function (r) { return r.json(); }).then(function (j) { toast('Server OK' + (j && j.values && j.values.serverVersion ? ' (v' + j.values.serverVersion + ')' : '')); })
        .catch(function (e) { toast('Cannot reach the server: ' + e.message, 5000); });
    }
    if (a === 'toggletc') { Store.set('transcode', !Store.get('transcode', false)); return settingsPage(); }
  }
  function back() {
    if (closeMenu()) return true;
    if (closeSide()) return true;
    var v = current();
    if (v && v.onBack && v.onBack() === true) return true;
    return pop();
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (el && Nav.root().contains(el)) act(el);
  });

  return { profiles: profilesView, openSide: openSide, closeSide: closeSide, sideOpen: function () { return !!sideEl; }, detail: detail, page: page, login: login, mount: mount, pop: pop, back: back, menu: menu, closeMenu: closeMenu, toast: toast, esc: esc, fmtTime: fmtTime,
           act: act, runSearch: runSearch, current: current, hasMenu: function () { return !!menuEl; } };
})();
