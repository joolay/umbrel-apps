/* Talks to the JoolzTV server. Every call carries the signed-in profile's token (header x-jtv-token). */
var Backend = (function () {
  var token = null, streamBase = null, streamExp = 0;

  function timeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('The JoolzTV server did not answer in time')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function call(method, path, body, tok, ms) {
    var h = { 'Content-Type': 'application/json' }, t = tok === undefined ? token : tok;
    if (t) h['x-jtv-token'] = t;
    return timeout(fetch(path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), ms || 20000).then(function (r) {
      var renew = r.headers.get('x-jtv-renew');
      if (renew && t && t === token) { token = renew; Store.set('token', renew); }   // an older sign-in is swapped for the server's own
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }
  return {
    setToken: function (t) { token = t || null; streamBase = null; streamExp = 0; },
    token: function () { return token; },
    call: call,
    login: function (email, password, qr, quick) { return call('POST', '/api/account/login', quick ? { quick: quick } : qr ? { qr: qr } : { email: email, password: password }, null); },
    quickSetup: function (kind, code, label) { return call('POST', '/api/quick', { kind: kind, code: code, label: label }); },
    quickStatus: function () { return call('GET', '/api/quick/status'); },
    quickRemove: function (id) { return call('DELETE', '/api/quick/' + id); },
    qrStart: function () { return call('POST', '/api/account/qr/start', {}, null); },
    qrPoll: function (id, secret) { return call('POST', '/api/account/qr/poll', { id: id, secret: secret }, null); },
    household: function (tok) { return call('GET', '/api/household', undefined, tok); },
    addProfile: function (email, password, name, tok, qr) { return call('POST', '/api/household/profiles', qr ? { qr: qr, name: name } : { email: email, password: password, name: name }, tok); },
    renameProfile: function (id, name, color) { return call('PATCH', '/api/household/profiles/' + id, { name: name, color: color }); },
    setAvatar: function (id, avatar) { return call('PATCH', '/api/household/profiles/' + id, { avatar: avatar }); },
    setMaxAge: function (id, maxAge) { return call('PATCH', '/api/household/profiles/' + id, { maxAge: maxAge }); },
    getTitles: function (id) { return call('GET', '/api/household/profiles/' + id + '/titles'); },
    putTitles: function (id, body) { return call('PUT', '/api/household/profiles/' + id + '/titles', body); },
    kidsWatching: function () { return call('GET', '/api/kids/watching'); },
    kidsHidden: function () { return call('GET', '/api/kids/hidden'); },
    kidsHide: function (t) { return call('POST', '/api/kids/hide', t); },
    kidsUnhide: function (imdb) { return call('POST', '/api/kids/unhide', { imdb: imdb }); },
    kidsRecommend: function (t, profiles) { return call('POST', '/api/kids/recommend', Object.assign({}, t, { profiles: profiles })); },
    kidsLimits: function (b) { return call('POST', '/api/kids/limits', b); },
    kidsExtend: function (b) { return call('POST', '/api/kids/extend', b); },
    kidsParents: function () { return call('GET', '/api/kids/parents'); },
    kidsAskTime: function (b) { return call('POST', '/api/kids/ask-time', b); },
    kidsTick: function (b) { return call('POST', '/api/kids/tick', b, undefined, 8000); },
    setKidMode: function (id, patch) { return call('PATCH', '/api/household/profiles/' + id, patch); },
    removeProfile: function (id) { return call('DELETE', '/api/household/profiles/' + id); },
    savePrefs: function (p) { return call('PUT', '/api/household/prefs', p); },
    me: function () { return call('GET', '/api/account/me'); },
    pull: function () { return call('GET', '/api/state'); },
    sync: function (state) { return call('POST', '/api/sync', { state: state }); },
    /* streaming goes through the sign-in: /s/<stream-token>/... (renewed when it has under 30 minutes left) */
    stream: function () {
      if (streamBase && streamExp - Date.now() > 30 * 60 * 1000) return Promise.resolve(streamBase);
      return call('POST', '/api/stream-token', {}).then(function (j) { streamBase = location.origin + '/s/' + j.st; streamExp = j.exp; return streamBase; });
    }
  };
})();
