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
    login: function (email, password) { return call('POST', '/api/account/login', { email: email, password: password }, null); },
    household: function (tok) { return call('GET', '/api/household', undefined, tok); },
    addProfile: function (email, password, name, tok) { return call('POST', '/api/household/profiles', { email: email, password: password, name: name }, tok); },
    renameProfile: function (id, name, color) { return call('PATCH', '/api/household/profiles/' + id, { name: name, color: color }); },
    setAvatar: function (id, avatar) { return call('PATCH', '/api/household/profiles/' + id, { avatar: avatar }); },
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
